'use strict';

// Project card and explorer: the project checkout, where merged cards land, as a file tree and a tabbed editor. It opens
// in a board dialog or in its own window (project.html). Saves are explicit; nothing here runs an agent or a model.
window.PromptboardExplorer = (() => {
  const { el: node, button, pref, setPref, ago } = window.PromptboardDom;
  const { codeLines, language, draftText } = window.PromptboardFiles;
  const TREE_KEY = 'promptboard.explorer.tree', MAX_TABS = 12, MAX_OPEN_FOLDERS = 64;
  const OFFLINE = 'Promptboard isn’t responding. Check that it is still running, then reload.';
  // 24×24 outline paths, drawn like the board's stage icons.
  const ICONS = {
    folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
    folderOpen: ['M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1', 'M3 17l2.5-6.5A1 1 0 0 1 6.4 10H21l-2.6 7.4a1 1 0 0 1-.9.6H4a1 1 0 0 1-1-1Z'],
    file: ['M6 3h8l4 4v14H6Z', 'M14 3v4h4'],
    newFile: ['M6 3h8l4 4v14H6Z', 'M14 3v4h4', 'M12 11v6', 'M9 14h6'],
    newFolder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M12 10v6', 'M9 13h6'],
    refresh: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v6h-6'],
    popOut: ['M14 4h6v6', 'm20 4-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    close: ['m6 6 12 12', 'M18 6 6 18'],
  };
  function icon(name, className = 'explorer-glyph') {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: className })) svg.setAttribute(key, value);
    for (const d of ICONS[name]) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
    return svg;
  }
  const iconButton = (name, label, action) => { const el = button('', action, 'icon-button explorer-action', label); el.setAttribute('aria-label', label); el.append(icon(name, '')); return el; };
  const fileKind = name => /\.(?:png|jpe?g|gif|webp|ico|bmp|avif|pdf)$/i.test(name) ? 'media' : ({ JSON: 'data', YAML: 'data', TOML: 'data', XML: 'data', Markdown: 'doc', Text: 'doc', HTML: 'markup', CSS: 'markup' })[language(name)] || 'code';
  const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
  const MARKS = { M: 'Modified', A: 'Added', U: 'Untracked: not in Git yet', '•': 'Has changes inside' };

  /** One explorer on one project. `request(path, signal, { method, body })` resolves the JSON answer or throws its message and code. */
  function explorer({ projectId, request, remote = () => false, popOut, close, onInfo }) {
    const api = (action, params = {}, options = {}) => request(`/api/projects/${encodeURIComponent(projectId)}/${action}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`, options.signal, options);
    const dirs = new Map(), expanded = new Set(), errors = new Map(), tabs = [];
    let info = null, marks = new Map(), changedDirs = new Set(), scopeVersion = '', selected = '', focusPath = '', active = null, creating = null, refreshing = null;

    const root = node('div', 'explorer');
    const head = node('header', 'explorer-head'), heading = node('div', 'explorer-heading');
    const title = node('h2', 'explorer-title', 'Project'); title.id = `explorer-title-${projectId}`;
    const meta = node('p', 'explorer-meta');
    heading.append(title, meta);
    const actions = node('div', 'explorer-head-actions');
    const ideButton = button('Open in IDE', () => void openIde(), 'secondary-button explorer-ide', 'Open the project folder in a code editor on this computer');
    const ideMenu = node('div', 'explorer-menu'); ideMenu.hidden = true; ideMenu.setAttribute('role', 'menu'); ideMenu.setAttribute('aria-label', 'Code editors on this computer');
    const ideWrap = node('div', 'explorer-ide-wrap'); ideWrap.append(ideButton, ideMenu);
    actions.append(ideWrap, ...(popOut ? [iconButton('popOut', 'Pop out to its own window', () => { if (tabs.some(dirty)) say('Save or close your unsaved files first: the new window opens the files from disk.'); else popOut(); })] : []),
      ...(close ? [iconButton('close', 'Close project explorer', close)] : []));
    head.append(heading, actions);
    const notice = node('p', 'explorer-notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
    const message = node('p', 'explorer-message'); message.setAttribute('role', 'status');

    const side = node('nav', 'explorer-side'); side.setAttribute('aria-label', 'Project files');
    const tools = node('div', 'explorer-tools');
    const filter = node('input', 'explorer-filter'); filter.type = 'search'; filter.placeholder = 'Filter files'; filter.setAttribute('aria-label', 'Filter the files in open folders');
    tools.append(filter, iconButton('newFile', 'New file', () => startCreate('file')), iconButton('newFolder', 'New folder', () => startCreate('directory')), iconButton('refresh', 'Refresh', () => void refresh()));
    const tree = node('ul', 'explorer-tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'Files');
    const treeNote = node('p', 'explorer-tree-note'); treeNote.setAttribute('role', 'status');
    side.append(tools, tree, treeNote);

    const sash = node('div', 'explorer-sash'); sash.tabIndex = 0;
    for (const [key, value] of Object.entries({ role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the file tree', 'aria-valuemin': '160' })) sash.setAttribute(key, value);

    const main = node('section', 'explorer-main'); main.setAttribute('aria-label', 'Editor');
    const tabBar = node('div', 'explorer-tabs'); tabBar.setAttribute('aria-label', 'Open files'); tabBar.hidden = true;
    const bar = node('div', 'explorer-bar'), crumb = node('p', 'explorer-path');
    const saveButton = button('Save', () => void save(active), 'secondary-button explorer-save', 'Save (⌘ / Ctrl + S)');
    bar.append(crumb, saveButton);
    const confirm = node('div', 'file-close-confirm explorer-confirm'); confirm.setAttribute('role', 'alert'); confirm.hidden = true;
    const surface = node('div', 'file-editor-surface explorer-surface'), code = node('div', 'file-code'); code.setAttribute('aria-hidden', 'true');
    const editor = node('textarea', 'file-editor'); editor.spellcheck = false; editor.wrap = 'off';
    surface.append(code, editor);
    const readOnly = node('div', 'explorer-readonly'), readOnlyText = node('p');
    readOnly.append(readOnlyText, button('Open in IDE', () => void openIde(), 'secondary-button')); readOnly.hidden = true;
    const empty = node('p', 'explorer-empty', 'Choose a file on the left to open it.');
    const status = node('p', 'explorer-status'); status.setAttribute('role', 'status');
    main.append(tabBar, bar, confirm, surface, readOnly, empty, status);
    const body = node('div', 'explorer-body'); body.append(side, sash, main);
    root.append(head, notice, message, body);

    const say = text => { message.textContent = text; };
    const dirty = tab => tab.draft !== undefined && tab.draft !== tab.text;
    const entryAt = path => dirs.get(parentOf(path))?.entries.find(entry => entry.name === path.slice(path.lastIndexOf('/') + 1));

    // ---- Git: the branch, the merge notice and the M / A / U markers ----
    async function loadStatus() {
      try { info = await api('git-status'); }
      catch (error) { info = null; notice.textContent = error.message; notice.hidden = false; return; }
      marks = new Map(info.status?.entries || []); changedDirs = new Set();
      for (const [path, letter] of info.status?.entries || []) if (letter !== 'I') for (let at = parentOf(path); at; at = parentOf(at)) changedDirs.add(at);
      title.textContent = `Project: ${info.project.name}`;
      meta.textContent = [info.folder, info.branch || 'No branch checked out', info.head && `${info.head.subject} · ${ago(info.head.at)}`].filter(Boolean).join(' · ');
      // What Delivery.merge really does: it refuses a target checkout with changed tracked files and never switches branches.
      notice.textContent = info.mergeBlocked ? `You have changes here that are not committed. Promptboard will not merge cards into ${info.target} until you commit or discard them.`
        : info.target && info.branch && info.branch !== info.target ? `This folder has ${info.branch} checked out. Cards merge into ${info.target}: check out ${info.target} to see them here.`
        : info.status ? '' : 'Git status is not available for this folder.';
      notice.hidden = !notice.textContent;
      onInfo?.(info);
    }
    /** The Git letter for a path. Files inside an untracked or ignored folder share its letter. */
    function markOf(path) {
      if (marks.has(path)) return marks.get(path);
      for (let at = parentOf(path); at; at = parentOf(at)) { const mark = marks.get(at); if (mark === 'U' || mark === 'I') return mark; }
      return '';
    }

    // ---- The tree: lazy folders, filter, keyboard ----
    async function loadDir(path, offset = 0) {
      try {
        const old = dirs.get(path), data = await api('files', { path, offset: String(offset) });
        if (offset) data.entries = [...(old?.entries || []), ...data.entries];
        // A refresh keeps the pages that were already shown.
        else while (old && data.next !== null && data.entries.length < old.entries.length) { const page = await api('files', { path, offset: String(data.next) }); data.entries.push(...page.entries); data.next = page.next; }
        dirs.set(path, data); scopeVersion = data.scopeVersion; errors.delete(path);
      } catch (error) {
        if (path && error.code === 'FILE_NOT_FOUND') { dirs.delete(path); expanded.delete(path); errors.delete(path); } // The folder was removed.
        else errors.set(path, error.message);
      }
      treeNote.textContent = [...errors].slice(0, 2).map(([where, text]) => `${where || 'Files'}: ${text}`).join(' ');
      treeNote.classList.toggle('file-error', errors.size > 0);
    }
    function rows() {
      const query = filter.value.trim().toLowerCase(), out = [], holds = new Map();
      // While filtering, a folder shows when its name or something already loaded inside it matches.
      const matches = (path, entry) => {
        if (!query || entry.name.toLowerCase().includes(query)) return true;
        if (entry.kind !== 'directory') return false;
        if (!holds.has(path)) holds.set(path, Boolean(dirs.get(path)?.entries.some(child => matches(joinPath(path, child.name), child))));
        return holds.get(path);
      };
      const walk = (dir, level) => {
        const data = dirs.get(dir);
        if (!data) return;
        for (const entry of data.entries) {
          const path = joinPath(dir, entry.name), folder = entry.kind === 'directory';
          if (entry.name === '.git' || !matches(path, entry)) continue; // Git's own folder never opens here, so it is not shown.
          const open = folder && !entry.blocked && (expanded.has(path) || Boolean(query) && dirs.has(path));
          out.push({ path, entry, level, folder, open });
          if (open) walk(path, level + 1);
        }
        if (!query && data.next !== null) out.push({ more: dir, next: data.next, level });
      };
      walk('', 1);
      return out;
    }
    function treeRow({ path, entry, level, folder, open }) {
      const item = node('li', 'explorer-row'), mark = markOf(path);
      item.setAttribute('role', 'treeitem'); item.dataset.path = path; item.setAttribute('aria-level', String(level)); item.style.setProperty('--level', String(level - 1));
      item.tabIndex = path === focusPath ? 0 : -1;
      item.setAttribute('aria-selected', String(path === selected));
      if (folder) item.setAttribute('aria-expanded', String(open));
      item.classList.toggle('is-dim', entry.name.startsWith('.') || mark === 'I' || entry.blocked);
      if (entry.blocked) { item.setAttribute('aria-disabled', 'true'); item.title = 'Links, special files and credentials are not opened here.'; }
      const chevron = node('span', 'explorer-chevron', folder ? (open ? '▾' : '▸') : ''); chevron.setAttribute('aria-hidden', 'true');
      const glyph = icon(folder ? (open ? 'folderOpen' : 'folder') : 'file'); glyph.dataset.kind = folder ? 'folder' : fileKind(entry.name);
      item.append(chevron, glyph, node('span', 'explorer-name', entry.name));
      const letter = mark === 'I' ? '' : mark || (folder && changedDirs.has(path) ? '•' : '');
      if (letter) { const badge = node('span', `explorer-mark mark-${letter === '•' ? 'inside' : letter}`, letter); badge.title = MARKS[letter]; badge.setAttribute('aria-hidden', 'true'); item.append(badge); }
      item.setAttribute('aria-label', [entry.name, letter && MARKS[letter], mark === 'I' && 'Ignored by Git'].filter(Boolean).join(', '));
      item.addEventListener('click', () => { focusPath = path; activate(path, entry); });
      return item;
    }
    function createRow() {
      const item = node('li', 'explorer-row explorer-create'), input = node('input');
      item.setAttribute('role', 'none'); item.style.setProperty('--level', String(creating.dir ? creating.dir.split('/').length : 0));
      input.type = 'text'; input.maxLength = 255; input.value = creating.draft;
      input.placeholder = creating.kind === 'file' ? 'Name of the new file' : 'Name of the new folder'; input.setAttribute('aria-label', input.placeholder);
      input.addEventListener('input', () => { creating.draft = input.value; });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); void finishCreate(); }
        // Escape cancels the name only, not the whole dialog.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); creating = null; renderTree(true); }
      });
      item.append(node('span', 'explorer-chevron'), icon(creating.kind === 'file' ? 'file' : 'folder'), input);
      return item;
    }
    function renderTree(focus = tree.contains(document.activeElement)) {
      const typing = document.activeElement?.closest?.('.explorer-create') && tree.contains(document.activeElement);
      const list = rows();
      if (!list.some(row => row.path === focusPath)) focusPath = list.find(row => row.path)?.path || '';
      const items = list.map(row => row.path ? treeRow(row) : (() => {
        const more = node('li', 'explorer-row explorer-more'); more.setAttribute('role', 'none'); more.style.setProperty('--level', String(row.level - 1));
        more.append(button('Show more', () => void loadDir(row.more, row.next).then(() => renderTree()), 'text-button')); return more;
      })());
      if (creating) items.splice(creating.dir ? list.findIndex(row => row.path === creating.dir) + 1 : 0, 0, createRow());
      if (!list.length && !creating && dirs.has('')) { const none = node('li', 'explorer-tree-empty', 'This folder is empty.'); none.setAttribute('role', 'none'); items.push(none); }
      tree.replaceChildren(...items);
      if (creating && (typing || focus === 'create')) tree.querySelector('.explorer-create input')?.focus();
      else if (focus) tree.querySelector('[role="treeitem"][tabindex="0"]')?.focus();
    }
    function activate(path, entry) {
      if (entry.blocked) { say(`${entry.name}: links, special files and credentials are not opened here.`); return; }
      selected = path;
      if (entry.kind === 'directory') void toggle(path);
      else { renderTree(); void openFile(path); }
    }
    async function toggle(path) {
      if (expanded.has(path)) { expanded.delete(path); renderTree(); return; }
      if (expanded.size >= MAX_OPEN_FOLDERS) { say(`Close a folder before opening another (at most ${MAX_OPEN_FOLDERS}).`); return; }
      expanded.add(path); renderTree();
      if (!dirs.has(path)) { await loadDir(path); renderTree(); }
    }
    tree.addEventListener('keydown', event => {
      const items = [...tree.querySelectorAll('[role="treeitem"]')], item = event.target.closest?.('[role="treeitem"]'), index = items.indexOf(item);
      if (index < 0 || event.target !== item) return;
      const path = item.dataset.path, open = item.getAttribute('aria-expanded') === 'true';
      const go = target => { if (!target) return; focusPath = target.dataset.path; for (const row of items) row.tabIndex = row === target ? 0 : -1; target.focus(); };
      const step = {
        ArrowDown: () => go(items[index + 1]), ArrowUp: () => go(items[index - 1]), Home: () => go(items[0]), End: () => go(items.at(-1)),
        ArrowRight: () => { if (!item.hasAttribute('aria-expanded')) return; if (!open) item.click(); else if (items[index + 1]?.dataset.path.startsWith(`${path}/`)) go(items[index + 1]); },
        ArrowLeft: () => { if (open) item.click(); else go(items.find(row => row.dataset.path === parentOf(path))); },
        Enter: () => item.click(), ' ': () => item.click(),
      }[event.key];
      if (!step) return;
      event.preventDefault(); step();
    });
    filter.addEventListener('input', () => renderTree(false));
    filter.addEventListener('keydown', event => { if (event.key === 'Escape' && filter.value) { event.preventDefault(); event.stopPropagation(); filter.value = ''; renderTree(false); } });

    // ---- New file and folder: an inline name in the tree, created on Enter ----
    function startCreate(kind) {
      const at = selected && entryAt(selected)?.kind === 'directory' ? selected : parentOf(selected);
      if (at && !expanded.has(at)) { expanded.add(at); if (!dirs.has(at)) void loadDir(at).then(() => renderTree('create')); }
      creating = { dir: at, kind, draft: '' }; filter.value = '';
      renderTree('create');
    }
    async function finishCreate() {
      const name = creating.draft.trim(), { dir, kind } = creating;
      if (!name) { creating = null; renderTree(true); return; }
      if (name.includes('/') || name.includes('\\')) { say('Use a name without slashes. Make the folder first, then add to it.'); return; }
      const path = joinPath(dir, name);
      try { await api('files', {}, { method: 'POST', body: { path, kind, scopeVersion } }); }
      catch (error) { say(error.message); renderTree('create'); return; }
      creating = null; selected = focusPath = path;
      say(`${kind === 'file' ? 'File' : 'Folder'} ${name} added.`);
      await loadDir(dir); await loadStatus();
      renderTree(kind !== 'file');
      if (kind === 'file') await openFile(path);
    }

    // ---- Tabs and the editor ----
    function remember() { if (active) { active.scrollTop = editor.scrollTop; active.scrollLeft = editor.scrollLeft; } }
    function show(tab, focus = false) { remember(); active = tab; renderTabs(); paint(true); if (focus && !editor.hidden) editor.focus(); }
    async function openFile(path) {
      let tab = tabs.find(item => item.path === path);
      if (!tab) {
        if (tabs.length >= MAX_TABS) { say(`Close a tab before opening another file (at most ${MAX_TABS}).`); return; }
        tab = { path }; tabs.push(tab);
        show(tab); await read(tab);
      }
      show(tab, true);
    }
    async function read(tab) {
      tab.loading = true; tab.error = ''; paintIf(tab);
      try {
        const data = await api('file', { path: tab.path });
        Object.assign(tab, { text: data.text, draft: data.text, version: data.version, scopeVersion: data.scopeVersion, note: '', conflict: false, notice: '' });
      } catch (error) {
        // Binary, non-UTF-8 and oversized files open read-only, with the reason.
        if (['FILE_UNSUPPORTED', 'FILE_TOO_LARGE'].includes(error.code)) tab.note = error.message; else tab.error = error.message;
      } finally { tab.loading = false; if (tab === active) { renderTabs(); paint(true); } }
    }
    const paintIf = tab => { if (tab === active) paint(); };
    async function check(tab) {
      try {
        const data = await api('file', { path: tab.path, version: tab.version });
        tab.error = '';
        if (data.unchanged) return;
        if (dirty(tab)) tab.conflict = true;
        else { Object.assign(tab, { text: data.text, draft: data.text, version: data.version, scopeVersion: data.scopeVersion, notice: 'Updated from disk.' }); if (tab === active) paint(true); }
      } catch (error) { tab.error = error.message; }
    }
    async function save(tab, overwrite = false) {
      if (!tab || tab.saving || tab.text === undefined || !dirty(tab) && !overwrite) return;
      tab.saving = true; tab.error = ''; tab.notice = 'Saving…'; paintIf(tab);
      try {
        // Keep mine: save over the newer disk version, but only that one (a third change is refused again).
        if (overwrite) { const current = await api('file', { path: tab.path }); tab.version = current.version; tab.scopeVersion = current.scopeVersion; }
        const text = tab.draft, data = await api('file', {}, { method: 'PUT', body: { path: tab.path, workspace: '', text, version: tab.version, scopeVersion: tab.scopeVersion } });
        Object.assign(tab, { text, version: data.version, conflict: false, notice: 'Saved.' });
        void loadStatus().then(() => renderTree());
      } catch (error) {
        tab.notice = '';
        if (error.code === 'FILE_CONFLICT') tab.conflict = true; else tab.error = error.message;
      } finally { tab.saving = false; renderTabs(); paintIf(tab); }
    }
    function closeTab(tab, force = false) {
      if (tab.saving) return;
      if (!force && dirty(tab)) { tab.closing = true; show(tab); confirm.querySelector('button')?.focus(); return; }
      tabs.splice(tabs.indexOf(tab), 1);
      if (active === tab) { active = null; show(tabs.at(-1) || null); } else renderTabs();
    }
    function renderTabs() {
      const focused = tabBar.contains(document.activeElement) ? document.activeElement.dataset.tab : null;
      tabBar.replaceChildren(...tabs.map(tab => {
        const name = tab.path.slice(tab.path.lastIndexOf('/') + 1), wrap = node('div', `explorer-tab${tab === active ? ' active' : ''}`);
        const pick = button(name, () => show(tab, true), 'explorer-tab-name', tab.path); pick.dataset.tab = tab.path;
        pick.setAttribute('aria-pressed', String(tab === active));
        if (dirty(tab)) { const dot = node('span', 'explorer-dot'); dot.setAttribute('aria-hidden', 'true'); pick.append(dot); pick.setAttribute('aria-label', `${name}, not saved`); }
        const shut = button('×', () => closeTab(tab), 'explorer-tab-close', `Close ${name}`); shut.setAttribute('aria-label', `Close ${name}`); shut.dataset.tab = `close:${tab.path}`;
        wrap.append(pick, shut); return wrap;
      }));
      tabBar.hidden = !tabs.length;
      if (focused) [...tabBar.querySelectorAll('button')].find(el => el.dataset.tab === focused)?.focus();
    }
    function paint(reset = false) {
      const tab = active, text = tab?.text !== undefined;
      empty.hidden = Boolean(tab); bar.hidden = !tab; crumb.textContent = tab?.path || '';
      surface.hidden = !text; readOnly.hidden = !tab?.note; readOnlyText.textContent = tab?.note || '';
      readOnly.lastChild.hidden = remote();
      if (text && (reset || code.dataset.path !== tab.path)) {
        code.replaceChildren(codeLines(tab.draft, language(tab.path))); code.dataset.path = tab.path;
        editor.value = tab.draft.replace(/\r\n/g, '\n'); editor.scrollTop = code.scrollTop = tab.scrollTop || 0; editor.scrollLeft = code.scrollLeft = tab.scrollLeft || 0;
      }
      if (tab) editor.setAttribute('aria-label', `Edit ${tab.path}`);
      editor.readOnly = Boolean(tab?.saving);
      saveButton.disabled = !tab || !text || !dirty(tab) || tab.saving || tab.conflict;
      saveButton.textContent = tab?.saving ? 'Saving…' : 'Save';
      confirm.hidden = !tab?.closing && !tab?.conflict;
      if (tab?.closing) confirm.replaceChildren(node('span', '', `Close ${tab.path} without saving? Your changes will be lost.`),
        button('Close without saving', () => closeTab(tab, true), 'secondary-button'), button('Keep editing', () => { tab.closing = false; paint(); editor.focus(); }, 'secondary-button'));
      else if (tab?.conflict) confirm.replaceChildren(node('span', '', 'This file changed on disk since you opened it. Nothing was overwritten: Reload takes the disk version, or keep your changes.'),
        button('Reload', () => { tab.conflict = false; void read(tab); }, 'secondary-button'), button('Keep mine and save anyway', () => void save(tab, true), 'secondary-button'));
      status.textContent = !tab ? '' : tab.error || tab.notice || (tab.loading ? 'Opening…' : tab.note ? 'Read only' : text ? `${language(tab.path)} · ${tab.draft.split('\n').length} lines${dirty(tab) ? ' · Not saved' : ''}` : '');
      status.classList.toggle('file-error', Boolean(tab?.error));
    }
    editor.addEventListener('input', () => {
      const tab = active; if (!tab || tab.saving || tab.text === undefined) return;
      const was = dirty(tab);
      tab.draft = draftText(tab.text, editor.value); tab.notice = '';
      code.replaceChildren(codeLines(tab.draft, language(tab.path))); code.scrollTop = editor.scrollTop; code.scrollLeft = editor.scrollLeft;
      if (was !== dirty(tab)) renderTabs();
      paint();
    });
    editor.addEventListener('scroll', () => { code.scrollTop = editor.scrollTop; code.scrollLeft = editor.scrollLeft; });
    root.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(active); } });

    // ---- Open in IDE: the editors found on this computer (never from a paired phone) ----
    async function openIde() {
      ideMenu.hidden = true;
      let list;
      try { list = await request('/api/editors'); } catch (error) { say(error.message); return; }
      const editors = Array.isArray(list.editors) ? list.editors : [], preferred = editors.find(item => item.id === list.preferred) || (editors.length === 1 ? editors[0] : null);
      if (preferred) return launch(preferred);
      if (!editors.length) { say('No code editor was found on this computer. Add yours on the board: the project’s ⋯ menu, then Open in IDE.'); return; }
      ideMenu.replaceChildren(...editors.map(item => { const choice = button(item.name, () => void launch(item), 'explorer-menu-item'); choice.setAttribute('role', 'menuitem'); return choice; }));
      ideMenu.hidden = false; ideMenu.firstChild.focus();
    }
    root.addEventListener('pointerdown', event => { if (!ideWrap.contains(event.target)) ideMenu.hidden = true; });
    ideMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ideMenu.hidden = true; ideButton.focus(); } });
    async function launch(item) {
      ideMenu.hidden = true;
      try { const result = await api('open', {}, { method: 'POST', body: { target: 'editor', editor: item.id } }); say(`${result.name || item.name} opened ${result.folder || 'the project'}.`); }
      catch (error) { say(error.message); }
    }

    // ---- The resizable split; its width is remembered in this browser ----
    function setWidth(width, save) {
      const max = Math.max(200, Math.round(body.clientWidth * 0.6)), next = Math.round(Math.min(max, Math.max(160, width)));
      root.style.setProperty('--explorer-tree', `${next}px`);
      sash.setAttribute('aria-valuemax', String(max)); sash.setAttribute('aria-valuenow', String(next));
      if (save) setPref(TREE_KEY, String(next));
    }
    const treeWidth = () => side.getBoundingClientRect().width;
    sash.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); sash.setPointerCapture?.(event.pointerId); root.dataset.dragging = 'true';
      const left = body.getBoundingClientRect().left, move = moved => setWidth(moved.clientX - left, false);
      const stop = () => { for (const [type, handler] of [['pointermove', move], ['pointerup', stop], ['pointercancel', stop]]) sash.removeEventListener(type, handler); delete root.dataset.dragging; setWidth(treeWidth(), true); };
      for (const [type, handler] of [['pointermove', move], ['pointerup', stop], ['pointercancel', stop]]) sash.addEventListener(type, handler);
    });
    sash.addEventListener('keydown', event => {
      const width = { ArrowLeft: treeWidth() - 16, ArrowRight: treeWidth() + 16, Home: 160, End: Infinity }[event.key];
      if (width === undefined) return;
      event.preventDefault(); setWidth(width, true);
    });
    sash.addEventListener('dblclick', () => { root.style.removeProperty('--explorer-tree'); try { localStorage.removeItem(TREE_KEY); } catch {} });
    if (Number(pref(TREE_KEY)) >= 160) root.style.setProperty('--explorer-tree', `${Number(pref(TREE_KEY))}px`);

    // ---- Refresh: the open folders, Git status and the open files. Also when this window gets focus again ----
    function refresh() {
      return refreshing ??= (async () => {
        try {
          ideButton.hidden = remote();
          await loadStatus();
          // Open folders that can be seen: their own parents are open too.
          const seen = path => { for (let at = parentOf(path); at; at = parentOf(at)) if (!expanded.has(at)) return false; return true; };
          for (const path of ['', ...expanded]) if (path === '' || dirs.has(path) && seen(path)) await loadDir(path);
          for (const tab of tabs) if (tab.version) await check(tab);
        } finally { refreshing = null; renderTree(); renderTabs(); paint(); }
      })();
    }
    window.addEventListener('focus', () => { if (root.isConnected && !root.closest('dialog:not([open])')) void refresh(); });
    window.addEventListener('beforeunload', event => { if (tabs.some(dirty)) { event.preventDefault(); event.returnValue = ''; } });
    paint();
    const focus = () => (tree.querySelector('[role="treeitem"][tabindex="0"]') || filter).focus();
    return { root, titleId: title.id, refresh, focus, dirty: () => tabs.some(dirty) };
  }

  /** The board: one lane after Done with the Project card, and the explorer in a large dialog. */
  function create({ request, remote = () => false }) {
    const explorers = new Map(), facts = new Map(), latest = new Map();
    const dialog = node('dialog', 'kanban-dialog explorer-dialog');
    document.body.append(dialog);
    const popOut = id => window.open(`/project.html?project=${encodeURIComponent(id)}`, '_blank', 'popup,width=1280,height=860,noopener');
    function open(project) {
      let view = explorers.get(project.id);
      if (!view) {
        // What the explorer reads from Git also updates the Project card.
        const onInfo = data => { facts.set(project.id, { key: facts.get(project.id)?.key, at: Date.now(), data, failed: false }); refill(project.id); };
        view = explorer({ projectId: project.id, request, remote, onInfo, popOut: () => { popOut(project.id); dialog.close(); }, close: () => dialog.close() });
        explorers.set(project.id, view);
      }
      if (dialog.firstChild !== view.root) dialog.replaceChildren(view.root);
      dialog.setAttribute('aria-labelledby', view.titleId);
      if (!dialog.open) dialog.showModal();
      void view.refresh().then(() => { if (dialog.open && !view.root.contains(document.activeElement)) view.focus(); });
    }
    const folderName = project => (project.repository.path || project.repository.root).split(/[\\/]/).filter(Boolean).at(-1) || project.repository.root;
    const lastMerged = project => project.tasks.filter(task => task.completion?.kind === 'merged').sort((a, b) => (b.completion.at || 0) - (a.completion.at || 0))[0] || null;
    function fill(section, project) {
      const known = facts.get(project.id), data = known?.data, merged = lastMerged(project);
      const pending = !data && !known?.failed ? '…' : 'Unavailable';
      const rows = [['Folder', folderName(project)], ['Branch', data ? data.branch || 'No branch checked out' : pending],
        ['Latest commit', data ? data.head ? `${data.head.subject} · ${ago(data.head.at)}` : 'No commits yet' : pending],
        ['Last merged', merged ? `${Number.isInteger(merged.number) ? `#${merged.number} ` : ''}${merged.title}` : 'No merged cards yet']];
      section.querySelector('.project-card-facts').replaceChildren(...rows.flatMap(([term, value]) => { const dd = node('dd', '', value); dd.title = value; return [node('dt', '', term), dd]; }));
      const warning = section.querySelector('.project-card-warning');
      warning.textContent = data?.mergeBlocked ? 'Changes here are not committed, so merges wait.' : ''; warning.hidden = !warning.textContent;
    }
    async function load(projectId, key) {
      const entry = { key, at: Date.now(), data: facts.get(projectId)?.data, pending: true };
      facts.set(projectId, entry);
      try { entry.data = await request(`/api/projects/${encodeURIComponent(projectId)}/git-status`); entry.failed = false; }
      catch { entry.failed = !entry.data; }
      finally { entry.pending = false; entry.at = Date.now(); }
      refill(projectId);
    }
    function refill(projectId) {
      const section = [...document.querySelectorAll('[data-project-lane]')].find(item => item.dataset.projectLane === projectId);
      if (section && latest.has(projectId)) fill(section, latest.get(projectId));
    }
    /** The lane after Done. It is not a column or a card: nothing can be dropped on it, moved, counted or started. */
    function lane(project) {
      latest.set(project.id, project);
      const section = node('section', 'project-lane'), heading = node('h3', 'project-lane-title');
      section.dataset.projectLane = project.id; heading.id = `project-lane-${project.id}`; section.setAttribute('aria-labelledby', heading.id);
      heading.append(icon('folder', 'kanban-stage-icon'), 'Project');
      const card = node('article', 'project-card');
      card.append(node('h4', 'project-card-name', `Project: ${project.name}`), node('dl', 'project-card-facts'), Object.assign(node('p', 'project-card-warning'), { hidden: true }));
      const actions = node('div', 'project-card-actions');
      actions.append(button('Open project', () => open(latest.get(project.id) || project), 'project-card-open', 'Browse and edit the project’s files'),
        button('Pop out', () => popOut(project.id), 'secondary-button project-card-popout', 'Open the project in its own window'));
      card.append(actions);
      section.append(heading, node('p', 'kanban-column-note', 'Merged work lands here'), card);
      fill(section, project);
      // Branch and latest commit come from Git: read again after a merge, and at most every 30 seconds.
      const key = `${project.repository.root}|${lastMerged(project)?.completion.at || ''}`, known = facts.get(project.id);
      if (!known?.pending && (!known || known.key !== key || Date.now() - known.at > 30000)) void load(project.id, key);
      return section;
    }
    return { lane, open };
  }

  /** project.html: the same explorer in its own window, with its own session; it keeps working after the board closes. */
  async function standalone(host) {
    const projectId = new URLSearchParams(location.search).get('project') || '';
    let token = '', remote = false;
    const fail = text => host.replaceChildren(node('p', 'explorer-page-note', text));
    // Like app.js readSession, which lives in the board page's own scope. Every failure has words a person can act on.
    const refused = text => Object.assign(new Error(text), { code: 'SESSION_UNAVAILABLE' });
    async function session() {
      let response;
      try { response = await fetch('/api/session', { cache: 'no-store' }); } catch { throw new Error(OFFLINE); }
      if (response.status === 401) { location.replace('/remote'); return false; } // A paired phone that must pair again.
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw refused(`${typeof data?.error === 'string' ? data.error : 'Promptboard could not start this window.'} Reload it in a moment.`);
      token = typeof data.token === 'string' ? data.token : ''; remote = Boolean(data.remote);
      if (!token) throw refused('Promptboard did not return a session for this window. Reload it in a moment.');
      return true;
    }
    async function request(path, signal, { method = 'GET', body } = {}) {
      const send = () => fetch(path, { method, signal, cache: 'no-store', headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      let response;
      try {
        response = await send();
        // A restarted app has a new token: read the session again and send once more (the server checks the token first).
        if (response.status === 403 && (await response.clone().json().catch(() => null))?.code === 'SESSION_EXPIRED' && await session()) response = await send();
      } catch (error) { throw error?.name === 'AbortError' || error?.code === 'SESSION_UNAVAILABLE' ? error : new Error(OFFLINE); }
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && data?.code === 'REMOTE_PAIRING_REQUIRED') location.replace('/remote');
      if (!response.ok) throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : 'The request failed. Nothing was changed.'), { code: data?.code });
      return data;
    }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) return fail('Open this window from the Project card on a Kanban board.');
    try { if (!await session()) return; } catch (error) { return fail(error.message); }
    const view = explorer({ projectId, request, remote: () => remote, onInfo: info => { document.title = `${info.project.name} — Promptboard`; } });
    host.replaceChildren(view.root);
    await view.refresh();
    view.focus();
  }

  const page = document.getElementById('project-explorer-page');
  if (page) void standalone(page);
  return { create };
})();
