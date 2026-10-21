'use strict';

// Live preview in a card's Details: Promptboard starts the project's development server in the card's worktree on
// this computer and links to it (a new tab; the page cannot embed it). A paired phone is told to open it on the
// computer. Status is read again every second only while a preview is starting; the board's cards show a small
// preview button while one runs.
window.PromptboardPreview = (() => {
  const { el, button, safeUrl } = window.PromptboardDom;
  const ICON = ['M4.5 4.5h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z', 'M8.5 20h7M12 16.5V20', 'm10.5 8 4 2.5-4 2.5Z'];
  const STARTING = ['installing', 'starting'];
  const icon = () => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) node.setAttribute(name, value);
    for (const d of ICON) { const path = document.createElementNS(node.namespaceURI, 'path'); path.setAttribute('d', d); node.append(path); }
    return node;
  };
  const link = (text, url, className) => { const node = el('a', className, text); node.href = safeUrl(url); node.target = '_blank'; node.rel = 'noopener noreferrer'; return node; };
  const note = (text, className = 'note') => el('p', className, text);

  /** host: { api, boardCall, announce, remote, project, previews, showRunning, openDetails } */
  function create(host) {
    const cache = new Map(), timers = new Map();
    let mounted = null;
    const path = taskId => `/api/tasks/${encodeURIComponent(taskId)}/preview`;
    async function call(taskId, method = 'GET', body) {
      const { response, data } = await host.api(path(taskId), { method, body, timeoutMs: 30000 });
      if (!response.ok) throw Object.assign(new Error(data.error || 'The preview request failed.'), { code: data.code });
      cache.set(taskId, data);
      // Preview changes do not change the board's revision, so the cards learn of them here.
      if (JSON.stringify(data.running) !== JSON.stringify(host.previews())) host.showRunning(data.running);
      return data;
    }

    /** Read the status every second while the card's preview is starting. */
    function poll(taskId) {
      if (timers.has(taskId)) return;
      timers.set(taskId, setTimeout(async () => {
        let data;
        try { data = await call(taskId); } catch { timers.delete(taskId); return; }
        timers.delete(taskId);
        render(taskId);
        if (STARTING.includes(data.preview?.status)) { poll(taskId); return; }
        if (data.preview?.status === 'ready') host.announce(`Preview ready for “${data.preview.title}”.`);
        else if (data.preview?.status === 'failed') host.announce(data.preview.message);
      }, 1000));
    }

    // A notice belongs to the section it was shown in; one left by a closed dialog is never shown elsewhere.
    async function start(taskId) {
      const own = mounted; own.notice = null;
      try { await call(taskId, 'POST', { confirm: true }); host.announce('Preview starting.'); }
      catch (error) { own.notice = { message: error.code === 'PREVIEW_LIMIT' ? 'Stop another preview first.' : error.message, limit: error.code === 'PREVIEW_LIMIT' }; await call(taskId).catch(() => {}); }
      render(taskId);
      if (STARTING.includes(cache.get(taskId)?.preview?.status)) poll(taskId);
    }

    async function stop(taskId) {
      const own = mounted, shown = own?.taskId;
      if (own) own.notice = null;
      try { await call(taskId, 'DELETE'); host.announce('Preview stopped.'); }
      catch (error) { if (own) own.notice = { message: error.message }; }
      if (shown && shown !== taskId) await call(shown).catch(() => {});
      if (shown) render(shown);
    }

    async function save(taskId, command, setup) {
      const project = host.project(), own = mounted;
      try { await host.boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}/preview`, { command, setup, expectedRevision: project.revision }); }
      catch (error) { own.notice = { message: error.message }; render(taskId); return; }
      own.notice = null; own.dirty = false;
      await call(taskId).catch(() => {});
      render(taskId);
      host.announce(command.trim() ? `Preview command saved: ${command.trim()}.` : 'Preview command removed.');
    }

    function actionsFor(taskId, data) {
      const preview = data.preview, nodes = [];
      if (host.remote()) {
        if (preview?.status === 'ready') nodes.push(note(`It runs there at ${preview.url}`));
        return nodes;
      }
      if (!data.workspace && !preview) nodes.push(note('This card’s folder is missing, so no preview can start. Restore its worktree first.'));
      else if (!data.settings) {
        const suggestion = data.suggestion;
        nodes.push(note('Promptboard starts the project’s development server in this card’s folder, so you can try the change before it merges.'));
        if (suggestion) {
          nodes.push(el('div', 'detail-actions'));
          nodes.at(-1).append(button(`Use ${suggestion.command}`, () => save(taskId, suggestion.command, suggestion.setup ? [suggestion.setup] : []), 'danger'));
          if (suggestion.setup) nodes.push(note(`It installs dependencies first with ${suggestion.setup} when the folder has no node_modules.`));
        } else nodes.push(note('Enter the command that starts it, such as npm run dev, under More.'));
      } else {
        const row = el('div', 'detail-actions');
        if (preview?.status === 'ready') row.append(link('Open preview', preview.url, 'preview-open'));
        if (!preview || preview.status === 'failed') row.append(button('Start preview', () => start(taskId), 'danger'));
        else row.append(button('Stop', () => stop(taskId)));
        nodes.push(row);
        if (!preview || preview.status === 'failed') nodes.push(note(`Runs ${data.settings.command} in this card’s folder on this computer${data.settings.setup.length ? `, after ${data.settings.setup.join(', ')} when node_modules is missing` : ''}.`));
      }
      const notice = mounted.notice;
      if (notice) {
        const line = note(notice.message, 'inline-error'); line.setAttribute('role', 'alert'); nodes.push(line);
        if (notice.limit) {
          const list = el('ul', 'preview-running');
          for (const item of data.running) {
            const row = el('li', '', `${Number.isInteger(item.number) ? `#${item.number} ` : ''}${item.title}`);
            const halt = button('Stop', () => stop(item.taskId), 'text-button'); halt.setAttribute('aria-label', `Stop the preview of ${item.title}`);
            row.append(' ', halt); list.append(row);
          }
          nodes.push(list);
        }
      }
      return nodes;
    }

    function statusText(data) {
      const preview = data.preview;
      if (host.remote()) return 'Open the preview on the computer.';
      if (!data.settings && data.workspace) return 'Set a preview command.';
      if (preview?.status === 'installing') return 'Installing dependencies…';
      if (preview?.status === 'starting') return 'Starting… waiting for the address.';
      if (preview?.status === 'ready') return `Running at ${preview.url}`;
      if (preview?.status === 'failed') return preview.message;
      return '';
    }

    function render(taskId) {
      if (!mounted || mounted.taskId !== taskId || !mounted.box.isConnected) return;
      const data = cache.get(taskId), { status, actions, output, pre, more, command, setup } = mounted;
      if (!data) { status.textContent = 'Checking the preview…'; return; }
      status.textContent = statusText(data);
      status.className = data.preview?.status === 'failed' && !host.remote() ? 'inline-error' : '';
      status.hidden = !status.textContent;
      // Buttons are rebuilt only when what they do changes, so polling never takes keyboard focus away.
      const signature = JSON.stringify([host.remote(), data.preview?.status, data.preview?.url, data.settings, data.suggestion, mounted.notice, mounted.notice?.limit && data.running]);
      if (signature !== mounted.signature) { mounted.signature = signature; actions.replaceChildren(...actionsFor(taskId, data)); }
      const lines = data.preview?.output || [];
      output.hidden = host.remote() || !lines.length;
      pre.textContent = lines.join('\n');
      more.hidden = host.remote();
      if (!mounted.dirty) {
        command.value = data.settings?.command || data.suggestion?.command || '';
        setup.value = (data.settings ? data.settings.setup : [data.suggestion?.setup].filter(Boolean)).join('\n');
        if (!data.settings && !data.suggestion && !mounted.opened) { more.open = true; mounted.opened = true; }
      }
    }

    /** The Preview section of a card's Details. `make(title, ...nodes)` is the dialog's own section helper. */
    function section(card, make) {
      const status = el('p'); status.setAttribute('role', 'status');
      const actions = el('div', 'preview-body');
      const output = el('details', 'preview-output'), pre = el('pre');
      output.append(el('summary', '', 'Output'), pre);
      const more = el('details', 'preview-more'), form = el('form', 'preview-settings');
      form.noValidate = true;
      const command = el('input'); command.type = 'text'; command.maxLength = 2000; command.spellcheck = false; command.autocomplete = 'off'; command.placeholder = 'npm run dev';
      const setup = el('textarea'); setup.rows = 2; setup.spellcheck = false; setup.placeholder = 'npm ci';
      const commandLabel = el('label', 'field-label', 'Preview command'), setupLabel = el('label', 'field-label', 'Install first, when node_modules is missing (one command per line)');
      commandLabel.append(command); setupLabel.append(setup);
      const submit = el('button', 'secondary-button', 'Save'); submit.type = 'submit';
      form.append(commandLabel, setupLabel, note('Each command runs as typed, without a shell. The preview command gets a free PORT, with HOST=127.0.0.1.'), submit);
      more.append(el('summary', '', 'More'), form);
      const box = make('Preview', status, actions, output, more);
      box.classList.add('task-preview');
      mounted = { taskId: card.id, box, status, actions, output, pre, more, command, setup, signature: null, notice: null, dirty: false, opened: false };
      const own = mounted;
      for (const field of [command, setup]) field.addEventListener('input', () => { own.dirty = true; });
      form.addEventListener('submit', event => {
        event.preventDefault();
        void save(card.id, command.value, setup.value.split('\n').map(line => line.trim()).filter(Boolean));
      });
      render(card.id);
      call(card.id).then(data => { render(card.id); if (STARTING.includes(data.preview?.status)) poll(card.id); })
        .catch(error => { if (own === mounted) { status.textContent = error.message; status.className = 'inline-error'; status.hidden = false; } });
      return box;
    }

    /** The small button on a board card while its preview runs: it opens the preview, or the card while it starts. */
    function cardButton(card) {
      const entry = (host.previews() || []).find(item => item.taskId === card.id);
      if (!entry) return null;
      const open = entry.status === 'ready' && safeUrl(entry.url) && !host.remote();
      const node = open ? link('', entry.url, 'icon-button preview-card') : button('', () => host.openDetails(card.id), 'icon-button preview-card');
      node.setAttribute('aria-label', open ? `Open preview: ${card.title}` : entry.status === 'ready' ? `Preview: ${card.title}` : `Preview starting: ${card.title}`);
      node.title = open ? `Open preview (${entry.url})` : entry.status === 'ready' ? 'Preview (open it on the computer)' : 'Preview starting…';
      if (entry.status !== 'ready') { node.classList.add('is-starting'); poll(card.id); }
      node.append(icon());
      return node;
    }

    return { section, cardButton };
  }
  return { create };
})();
