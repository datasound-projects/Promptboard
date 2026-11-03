'use strict';

// Chat owns its conversation UI. Its only workspace seam is opt-in browser History;
// all other source retrieval happens through the server's read-only services.
window.PromptboardChat = (() => {
  const { el, button } = window.PromptboardDom;
  const AGENTS = {
    workspace: { title: 'Workspace', description: 'Find answers across your saved projects and app data.', placeholder: 'What needs my attention across all projects?', suggestions: ['List my projects and their current status.', 'Which cards or Network jobs need attention?', 'Find the saved prompts about my project.'] },
    guide: { title: 'App guide', description: 'Learn exactly how to use the features in this version.', placeholder: 'How do I set up and run a Network pipeline?', suggestions: ['Walk me through Network, from an agent to an approved report.', 'Explain the difference between Origin, Compose and Kanban.', 'Where do I change the default agent and what do the fields mean?'] },
  };
  const PAGES = new Set(['#/', '#/origin', '#/kanban', '#/base', '#/network', '#/chat']);
  const date = value => value ? new Date(value).toLocaleString() : '';

  function create(host) {
    const root = document.getElementById('chat-view'), sidebar = document.getElementById('chat-sidebar-panel');
    if (!root || !sidebar) return null;
    root.innerHTML = `<div class="chat-shell">
      <header class="chat-heading"><div><p class="eyebrow">PROMPTBOARD</p><h1 id="chat-heading">Chat</h1><p class="note">Ask about your workspace or get step-by-step app guidance.</p></div><span class="chat-version" id="chat-version"></span></header>
      <div class="chat-agent-choice" role="group" aria-label="Chat agent">
        <button type="button" data-agent="workspace" aria-pressed="true"><strong>Workspace</strong><span>Projects, plans, prompts, boards, Base and Network.</span></button>
        <button type="button" data-agent="guide" aria-pressed="false"><strong>App guide</strong><span>What to enter, where to find it and why it matters.</span></button>
      </div>
      <details class="chat-settings"><summary>Response settings and context</summary><div class="chat-response-fields">
        <label class="field-label">CLI<select id="chat-provider" aria-label="Chat CLI"></select></label>
        <label class="field-label">Model<input id="chat-model" type="text" maxlength="100" autocomplete="off" spellcheck="false" placeholder="CLI default"></label>
        <label class="field-label">Effort<select id="chat-effort"><option value="">CLI default</option></select></label>
      </div><label class="check-row" id="chat-history-option"><input id="chat-include-history" type="checkbox"> Include this browser’s Compose History</label>
        <p class="note" id="chat-context-note"></p><button type="button" class="text-button" id="chat-refresh-clis">Refresh CLIs</button></details>
      <p class="inline-error" id="chat-error" role="alert" hidden></p>
      <div class="chat-thread" id="chat-thread" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" tabindex="0"></div>
      <form class="chat-composer" id="chat-form"><label for="chat-input" class="sr-only">Your question</label><textarea id="chat-input" maxlength="8000" rows="3" aria-describedby="chat-privacy chat-keyboard"></textarea>
        <div class="chat-compose-actions"><span id="chat-status" role="status" aria-live="polite"></span><button type="button" class="secondary-button" id="chat-stop" hidden>Stop response</button><button type="submit" class="danger" id="chat-send">Send</button></div>
        <p class="note" id="chat-privacy">Read-only. Questions and retrieved excerpts go to your selected CLI. Chat cannot change projects, settings or tasks.</p><p class="note" id="chat-keyboard">Enter to send · Shift+Enter for a new line</p>
      </form></div>`;
    sidebar.innerHTML = `<button type="button" class="new-prompt" id="chat-new"><span aria-hidden="true">＋</span> New conversation</button><div class="history-label"><span id="chat-history-heading">WORKSPACE CHATS</span></div><label class="search-wrap"><input type="search" id="chat-history-search" aria-label="Find a conversation" placeholder="Find a conversation…"></label><ul class="chat-history-list" id="chat-history-list"></ul><p class="note" id="chat-history-empty">No conversations yet.</p>`;
    const $ = selector => root.querySelector(selector), side = selector => sidebar.querySelector(selector);
    const input = $('#chat-input'), thread = $('#chat-thread'), provider = $('#chat-provider'), model = $('#chat-model'), effort = $('#chat-effort');
    let metadata = null, mode = 'workspace', current = null, conversations = [], visible = false, loading = 0, controller = null, runningId = null, poll = null, stage = '', settingsDirty = false;
    const drafts = new Map(), lastByMode = new Map(), rendered = new Map(), historyRows = new Map();
    const draftKey = () => current?.id || `new:${mode}`;
    const busy = () => Boolean(controller || current?.running);
    const error = message => { $('#chat-error').textContent = message || ''; $('#chat-error').hidden = !message; };
    const call = async (path, options) => {
      const { response, data } = await host.api(path, options);
      if (!response.ok) throw Object.assign(new Error(data.error || 'The chat request failed.'), { code: data.code, status: response.status });
      return data;
    };
    const responseSettings = () => ({ provider: provider.value, model: model.value.trim(), effort: effort.value });
    const foundProvider = () => host.providers?.().find(item => item.id === provider.value);
    function effortChoices(selected = '') {
      const levels = provider.value === 'gemini' ? [''] : provider.value === 'codex' ? ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['', 'low', 'medium', 'high', 'xhigh', 'max'];
      effort.replaceChildren(...levels.map(value => new Option(value || 'CLI default', value)));
      effort.value = levels.includes(selected) ? selected : '';
    }
    function setSettings(settings) {
      const supported = metadata.providers.some(item => item.id === settings?.provider);
      provider.value = supported ? settings.provider : metadata.providers.find(item => host.providers?.().some(p => p.id === item.id && p.available))?.id || 'claude';
      model.value = supported ? settings?.model || '' : ''; effortChoices(supported ? settings?.effort || '' : ''); settingsDirty = false;
    }
    function controls() {
      const running = busy(), available = Boolean(foundProvider()?.available);
      $('#chat-send').disabled = running || !input.value.trim() || !available || !metadata;
      $('#chat-stop').hidden = !running;
      $('#chat-status').textContent = running ? controller && runningId && current?.id !== runningId ? 'A response is running in another conversation.' : stage || 'A response is running…' : !available ? 'Set up and sign in to a supported CLI to chat.' : '';
      for (const node of root.querySelectorAll('[data-agent], #chat-provider, #chat-model, #chat-effort, #chat-include-history')) node.disabled = running;
      side('#chat-new').disabled = running;
      for (const node of sidebar.querySelectorAll('a, button[data-delete]')) { if (node.tagName === 'BUTTON') node.disabled = running; else node.setAttribute('aria-disabled', String(running && node.dataset.chatId !== current?.id)); }
      for (const node of root.querySelectorAll('[data-agent]')) node.setAttribute('aria-pressed', String(node.dataset.agent === mode));
      $('#chat-history-option').hidden = mode !== 'workspace';
      $('#chat-context-note').textContent = mode === 'workspace' ? 'Searches saved workspace records. Shared project prompts are included. Browser History is included only if you select it. Unsaved edits and project files are not read.' : 'Uses this installed version’s app guides and interface text. Private workspace records and browser History are not sent.';
      input.placeholder = AGENTS[mode].placeholder;
      side('#chat-history-heading').textContent = mode === 'guide' ? 'APP GUIDE CHATS' : 'WORKSPACE CHATS';
    }
    function history() {
      const query = side('#chat-history-search').value.trim().toLowerCase();
      const rows = conversations.filter(chat => chat.mode === mode && (!query || chat.title.toLowerCase().includes(query)));
      const focused = sidebar.contains(document.activeElement) ? document.activeElement : null;
      const nodes = rows.map(chat => {
        let row = historyRows.get(chat.id);
        if (!row) {
          const li = el('li', 'chat-history-row'), link = el('a', 'chat-history-link');
          row = { li, link, chat }; historyRows.set(chat.id, row);
          link.href = `#/chat/${chat.id}`; link.dataset.chatId = chat.id;
          link.addEventListener('click', event => { if (busy() && chat.id !== current?.id) { event.preventDefault(); return; } drafts.set(draftKey(), input.value); });
          const remove = button('×', () => confirmDelete(row.chat), 'chat-history-delete icon-button');
          remove.dataset.delete = chat.id; remove.title = 'Delete conversation'; row.remove = remove;
          li.append(link, remove);
        }
        row.chat = chat; const { li, link, remove } = row;
        if (link.textContent !== (chat.title || 'New conversation')) link.textContent = chat.title || 'New conversation';
        if (current?.id === chat.id) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
        remove.setAttribute('aria-label', `Delete conversation “${chat.title}”`);
        return li;
      });
      const list = side('#chat-history-list'), keep = new Set(nodes);
      for (const child of [...list.children]) if (!keep.has(child)) child.remove();
      nodes.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
      const known = new Set(conversations.map(chat => chat.id));
      for (const id of historyRows.keys()) if (!known.has(id)) historyRows.delete(id);
      side('#chat-history-empty').hidden = rows.length > 0;
      if (focused?.isConnected && document.activeElement === document.body) focused.focus({ preventScroll: true });
      controls();
    }
    function welcome() {
      const section = el('section', 'chat-welcome'); section.append(el('h2', '', mode === 'guide' ? 'Understand every step.' : 'See the whole workspace.'));
      section.append(el('p', 'note', AGENTS[mode].description + ' Answers include source passages and their version or snapshot time.'));
      const suggestions = el('div', 'chat-suggestions');
      for (const suggestion of AGENTS[mode].suggestions) suggestions.append(button(suggestion, () => { input.value = suggestion; drafts.set(draftKey(), suggestion); controls(); input.focus(); }, 'secondary-button'));
      section.append(suggestions); return section;
    }
    function sourcePanel(message, source, quotes) {
      const panel = el('div', 'chat-source-panel');
      panel.append(el('strong', '', source.title), el('p', 'note', `${source.kind === 'guide' || source.kind === 'interface' ? 'Installed app guide' : source.kind === 'browser' ? 'Browser-provided History' : 'Saved workspace record'} · ${message.build?.id || ''} · ${date(message.capturedAt)}`));
      for (const quote of [...new Set(quotes)]) panel.append(el('blockquote', '', quote));
      const passage = el('details'); passage.append(el('summary', '', 'Read the retrieved passage'), el('pre', '', source.text || '')); panel.append(passage);
      if (PAGES.has(source.page) && source.page !== '#/chat') { const link = el('a', 'text-link', 'Open this app page'); link.href = source.page; panel.append(link); }
      return panel;
    }
    function messageNode(message) {
      const article = el('article', `chat-message chat-message-${message.role}`); article.dataset.messageId = message.id;
      article.append(el('p', 'chat-message-role', message.role === 'user' ? 'You' : AGENTS[mode].title));
      if (message.role === 'user' || !message.sections?.length) article.append(el('div', 'chat-message-text', message.text || ''));
      else {
        const sources = new Map((message.sources || []).map((source, index) => [source.id, { ...source, number: index + 1 }]));
        for (const section of message.sections) {
          const block = el('div', 'chat-answer-section'); block.append(el('div', 'chat-message-text', section.text));
          const refs = el('div', 'chat-source-buttons');
          for (const id of [...new Set(section.citations.map(item => item.sourceId))]) {
            const source = sources.get(id); if (!source) continue;
            const toggle = button(`Source ${source.number}`, () => {
              const open = toggle.getAttribute('aria-expanded') === 'true'; toggle.setAttribute('aria-expanded', String(!open));
              if (!panel.childNodes.length) panel.append(sourcePanel(message, source, section.citations.filter(item => item.sourceId === id).map(item => item.quote)));
              panel.hidden = open;
            }, 'text-button');
            const panel = el('div'); panel.hidden = true; panel.id = `chat-source-${message.id}-${source.id}-${article.querySelectorAll('.chat-source-buttons').length}`;
            toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', panel.id); refs.append(toggle); block.append(panel);
          }
          block.insertBefore(refs, block.children[1] || null); article.append(block);
        }
      }
      if (message.role !== 'user') {
        if (message.build) article.append(el('p', 'chat-message-meta', `v${message.build.version} · sources read ${date(message.capturedAt)}`));
        if (message.build && metadata && message.build.fingerprint !== metadata.build.fingerprint) article.append(el('p', 'chat-warning', 'This answer is from an older app build. Ask again for current-version guidance.'));
        if (message.workspaceChanged) article.append(el('p', 'chat-warning', 'Workspace data changed while this answer was prepared. These sources reflect the earlier snapshot; ask again for current status.'));
        for (const note of message.uncertainties || []) article.append(el('p', 'chat-warning', note));
        if (message.coverage) {
          const coverage = el('details', 'chat-coverage'), value = message.coverage;
          const count = (number, label) => Number.isSafeInteger(number) ? `${number} ${label}` : `${label}: total unavailable`;
          coverage.append(el('summary', '', 'What was searched?'), el('p', 'note', `Known totals: ${[count(value.projects, 'projects'), count(value.baseResources, 'Base resources'), count(value.networkAgents, 'Network agents'), count(value.graphs, 'graphs'), count(value.jobs, 'jobs'), count(value.pipelines, 'pipelines')].join(' · ')}`));
          coverage.append(el('p', 'note', `${message.retrievedSources || message.sources?.length || 0} source passages were supplied for this answer. Browser History ${value.browserHistory?.included ? 'was included' : 'was not included'}.`));
          for (const text of [...(value.limits || []), ...(value.unavailable || []).map(item => `Unavailable: ${item.source}`), ...(value.clipped || []).map(item => `Clipped: ${item}`)]) coverage.append(el('p', 'note', text));
          article.append(coverage);
        }
        const actions = el('div', 'chat-message-actions');
        actions.append(button('Copy answer', async () => {
          const sources = (message.sources || []).map(source => `${source.title} (${message.build?.id || ''}, ${date(message.capturedAt)})`).join('\n');
          try { await navigator.clipboard.writeText(`${message.text}${sources ? `\n\nSources:\n${sources}` : ''}`); host.announce('Answer copied.'); } catch { host.announce('Copy is unavailable. Select the answer text to copy it.'); }
        }, 'text-button'));
        if (['failed', 'cancelled'].includes(message.status)) actions.append(button('Use the question again', () => {
          const at = current.messages.findIndex(item => item.id === message.id), question = current.messages.slice(0, at).findLast(item => item.role === 'user');
          if (question) { input.value = question.text; drafts.set(draftKey(), input.value); controls(); input.focus(); }
        }, 'text-button'));
        article.append(actions);
      }
      return article;
    }
    function messages({ reset = false, forceBottom = false } = {}) {
      const follow = forceBottom || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
      if (reset) { thread.replaceChildren(); rendered.clear(); }
      if (!current?.messages.length) { if (!thread.querySelector('.chat-welcome')) { thread.replaceChildren(welcome()); rendered.clear(); } return; }
      thread.querySelector('.chat-welcome')?.remove();
      for (const message of current.messages) if (!rendered.has(message.id)) { const node = messageNode(message); thread.append(node); rendered.set(message.id, node); }
      if (current.interrupted && !thread.querySelector('.chat-interrupted')) thread.append(el('p', 'chat-warning chat-interrupted', 'The previous response was interrupted. It will not restart automatically. You can ask the question again.'));
      if (follow) thread.scrollTop = thread.scrollHeight;
    }
    function append(message) {
      if (!current.messages.some(item => item.id === message.id)) current.messages.push(message);
      messages();
    }
    async function list() { conversations = (await call('/api/chat/conversations')).chats || []; history(); }
    function schedulePoll() {
      clearTimeout(poll);
      if (!visible || controller || !current?.running) return;
      poll = setTimeout(async () => {
        try { const id = current?.id; if (!id) return; const result = await call(`/api/chat/conversations/${id}`); if (current?.id !== id) return; current = result.chat; messages(); controls(); if (!current.running) await list(); schedulePoll(); }
        catch (failure) { error(failure.message); }
      }, 1500);
    }
    async function show() {
      visible = true; const sequence = ++loading; error('');
      try {
        const info = await call('/api/chat'); if (!visible || sequence !== loading) return;
        const buildChanged = metadata && metadata.build.fingerprint !== info.build.fingerprint; metadata = info;
        if (!provider.options.length) { provider.replaceChildren(...metadata.providers.map(item => new Option(item.name, item.id))); setSettings(host.defaults?.() || {}); }
        $('#chat-version').textContent = `v${metadata.build.version} · ${metadata.build.fingerprint.slice(0, 8)}`;
        $('#chat-version').title = `Guidance is tied to installed build ${metadata.build.id}`;
        const id = /^#\/chat\/([0-9a-f-]{36})$/.exec(location.hash)?.[1];
        if (id) {
          const result = await call(`/api/chat/conversations/${id}`); if (!visible || sequence !== loading) return;
          const changed = current?.id !== id;
          if (changed) drafts.set(draftKey(), input.value);
          current = result.chat; mode = current.mode; lastByMode.set(mode, current.id);
          if (changed || !settingsDirty) setSettings(current.settings);
          if (changed) input.value = drafts.get(draftKey()) || '';
          messages({ reset: changed || buildChanged, forceBottom: changed });
        } else if (!controller) {
          const changed = Boolean(current); if (changed) drafts.set(draftKey(), input.value);
          current = null; input.value = drafts.get(draftKey()) || ''; messages({ reset: changed });
        }
        await list(); controls(); schedulePoll();
        if (metadata.missingGuides?.length) error('Some built-in guide sections are unavailable in this installation. Answers may be limited.');
      } catch (failure) { if (visible && sequence === loading) { if (failure.code === 'VERSION_CHANGED') { metadata = null; controls(); } error(failure.message); } }
    }
    function chooseAgent(next) {
      if (busy() || mode === next) return;
      drafts.set(draftKey(), input.value); mode = next; current = null; error('');
      input.value = drafts.get(draftKey()) || ''; messages({ reset: true }); controls(); history();
      const id = lastByMode.get(mode);
      if (id) location.hash = `#/chat/${id}`;
      else location.hash = '#/chat';
    }
    async function send() {
      if (busy() || !input.value.trim() || !foundProvider()?.available || !metadata) return;
      const question = input.value.trim(), settings = responseSettings(), requestedMode = mode, initialKey = draftKey(), initialHash = location.hash;
      let conversation = current;
      const historyQuery = [...(conversation?.messages || []).filter(item => item.role === 'user').slice(-2).map(item => item.text), question].join('\n');
      const browser = requestedMode === 'workspace' && $('#chat-include-history').checked ? host.browserContext?.(historyQuery) || { history: [], catalog: [], total: 0 } : undefined;
      error(''); stage = 'Opening conversation…';
      controller = new AbortController(); controls(); let finished = false;
      try {
        const info = await call('/api/chat'), buildChanged = metadata.build.fingerprint !== info.build.fingerprint;
        metadata = info; $('#chat-version').textContent = `v${info.build.version} · ${info.build.fingerprint.slice(0, 8)}`;
        if (buildChanged) messages({ reset: true });
        if (!conversation) {
          const result = await call('/api/chat/conversations', { method: 'POST', body: { mode: requestedMode, settings } });
          conversation = result.chat; lastByMode.set(requestedMode, conversation.id); drafts.set(conversation.id, drafts.get(initialKey) || question); drafts.delete(initialKey);
          if (location.hash === initialHash && draftKey() === initialKey) {
            current = conversation; window.history.replaceState(null, '', `#/chat/${conversation.id}`); messages({ reset: true });
          }
        }
        runningId = conversation.id;
        const body = { text: question, settings };
        if (browser !== undefined) body.browserContext = browser;
        const response = await host.streamApi(`/api/chat/conversations/${conversation.id}/messages`, body, { signal: controller.signal });
        if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || 'The response could not start.'); }
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        const receive = event => {
          if (event.type === 'accepted') {
            if ((drafts.get(conversation.id) || '').trim() === question) drafts.set(conversation.id, '');
            if (current?.id === conversation.id) { append(event.message); if (input.value.trim() === question) input.value = ''; }
          }
          else if (event.type === 'stage') { stage = event.stage; controls(); }
          else if (event.type === 'answer' && current?.id === conversation.id) append(event.message);
          else if (event.type === 'done') { if (current?.id === conversation.id) current = { ...current, ...event.chat }; finished = true; }
          else if (event.type === 'error' && current?.id === conversation.id) { error(event.message); }
        };
        for (;;) {
          const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line) receive(JSON.parse(line)); }
          if (buffer.length > 1024 * 1024) throw new Error('The chat response exceeded the supported size. Reopen the conversation to check its saved result.');
          if (done) { if (buffer.trim()) receive(JSON.parse(buffer)); break; }
        }
        if (!finished && current?.id === conversation.id) { const result = await call(`/api/chat/conversations/${conversation.id}`); if (current?.id === conversation.id) { current = result.chat; messages(); } }
      } catch (failure) { if (failure.name !== 'AbortError' && (current?.id === conversation?.id || draftKey() === initialKey)) error(failure.message); }
      finally {
        controller = null; runningId = null; stage = '';
        if (conversation && current?.id === conversation.id && !finished) { try { const result = await call(`/api/chat/conversations/${conversation.id}`); if (current?.id === conversation.id) { current = result.chat; messages(); } } catch {} }
        controls(); try { await list(); } catch {} schedulePoll();
      }
    }
    async function stop() {
      const id = runningId || current?.id;
      if (!id || !busy()) return; stage = 'Stopping response…'; controls();
      try { await call(`/api/chat/conversations/${id}/stop`, { method: 'POST', body: {} }); }
      catch (failure) { if (failure.code !== 'NOT_RUNNING') { error(failure.message); controller?.abort(); } }
    }
    function confirmDelete(chat) {
      if (busy()) return;
      const dialog = el('dialog', 'kanban-dialog'), heading = el('h2', '', 'Delete conversation?'); heading.id = 'chat-delete-heading'; dialog.setAttribute('aria-labelledby', heading.id);
      const actions = el('div', 'kanban-dialog-actions'), cancel = button('Cancel', () => dialog.close(), 'secondary-button');
      const remove = button('Delete conversation', async () => {
        remove.disabled = true;
        try { await call(`/api/chat/conversations/${chat.id}`, { method: 'DELETE' }); drafts.delete(chat.id); if (current?.id === chat.id) { current = null; lastByMode.delete(mode); location.hash = '#/chat'; input.value = drafts.get(draftKey()) || ''; messages({ reset: true }); } dialog.close(); await list(); }
        catch (failure) { error(failure.message); remove.disabled = false; }
      }, 'danger');
      actions.append(cancel, remove); dialog.append(heading, el('p', '', `Delete “${chat.title}” and its saved chat history? Workspace records stay as they are.`), actions); document.body.append(dialog);
      dialog.addEventListener('close', () => { dialog.remove(); side('#chat-new').focus(); }); dialog.showModal(); cancel.focus();
    }
    $('#chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
    input.addEventListener('input', () => { drafts.set(draftKey(), input.value); controls(); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !busy()) { event.preventDefault(); $('#chat-form').requestSubmit(); } });
    for (const node of root.querySelectorAll('[data-agent]')) node.addEventListener('click', () => chooseAgent(node.dataset.agent));
    provider.addEventListener('change', () => { settingsDirty = true; model.value = ''; effortChoices(); controls(); });
    model.addEventListener('input', () => { settingsDirty = true; }); effort.addEventListener('change', () => { settingsDirty = true; });
    $('#chat-stop').addEventListener('click', () => void stop());
    $('#chat-refresh-clis').addEventListener('click', async () => { try { await host.refreshProviders?.(); controls(); } catch (failure) { error(failure.message); } });
    side('#chat-history-search').addEventListener('input', history);
    side('#chat-new').addEventListener('click', () => { if (busy()) return; drafts.set(draftKey(), input.value); current = null; lastByMode.delete(mode); input.value = drafts.get(draftKey()) || ''; location.hash = '#/chat'; error(''); messages({ reset: true }); history(); input.focus(); });
    messages(); controls();
    return { show, open: () => { location.hash = current?.id ? `#/chat/${current.id}` : '#/chat'; }, leave: () => { visible = false; loading++; clearTimeout(poll); }, refreshProviders: controls };
  }
  return { create };
})();
