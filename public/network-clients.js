'use strict';

// Network → Settings: external clients (docs/network/architecture.md §10.3, §22). The owner turns the machine listener on
// or off and picks its port, creates scope-limited clients, sees each new token exactly once (copied only when Copy is
// clicked), revokes or rotates clients, and copies setup snippets for MCP hosts that name the token by its environment
// variable, never by value. The token lives only in this module's own dialog and is removed from the page when the
// dialog closes. Turning the listener on, creating and rotating are refused from a paired phone by the server.
window.PromptboardNetworkClients = (() => {
  const { el, button, plural, ago } = window.PromptboardDom;
  const PERMISSIONS = [
    ['read_agents', 'See its agents', 'The name, provider and tool modes of the agents you choose; never their instructions or Base content.'],
    ['submit_jobs', 'Submit jobs', 'Queue read-only jobs for those agents. A job never writes files.'],
    ['read_job_result', 'Read results', 'Fetch the results of jobs it submitted.'],
    ['cancel_own_jobs', 'Cancel its jobs', 'Cancel jobs it submitted that have not ended.'],
    ['read_scoped_memory', 'Jobs may read memory', 'Its jobs may read the agent’s approved memory, and the lessons of the projects you choose. Off: its jobs get no memory.'],
  ];
  const PERMISSION_NAMES = Object.fromEntries(PERMISSIONS.map(([id, label]) => [id, label]));
  const DEFAULT_PERMISSIONS = ['read_agents', 'submit_jobs', 'read_job_result', 'cancel_own_jobs'];
  const EXPIRY = [['', 'Never'], ['30', 'In 30 days'], ['90', 'In 90 days'], ['365', 'In 1 year']];
  const STATES = { active: ['Active', 'ok'], revoked: ['Revoked', 'off'], expired: ['Expired', 'warn'] };
  const HOSTS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['other', 'Other MCP hosts'], ['rest', 'REST']];
  const note = (text, className = 'note') => el('p', className, text);
  const labelled = (text, control, className = 'field-label') => { const label = el('label', className); label.append(text, control); return label; };
  const when = at => new Date(at).toLocaleDateString();

  /** The setup text for each host: the listener address and the MCP command, with the token only as a variable name. */
  function snippets(status) {
    const url = status.listener.url || `http://127.0.0.1:${status.listener.port || 4330}`, [command, ...args] = [status.mcp.command, ...status.mcp.args];
    const server = env => JSON.stringify({ mcpServers: { promptboard: { command, args, env: { PROMPTBOARD_MACHINE_URL: url, ...env } } } }, null, 2);
    return {
      claude: [server({ PROMPTBOARD_MACHINE_TOKEN: '${PROMPTBOARD_MACHINE_TOKEN}' }), 'Save this as .mcp.json in your project. Claude Code fills in ${PROMPTBOARD_MACHINE_TOKEN} from the environment it starts in.'],
      codex: [`[mcp_servers.promptboard]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map(arg => JSON.stringify(arg)).join(', ')}]\nenv = { PROMPTBOARD_MACHINE_URL = ${JSON.stringify(url)} }\nenv_vars = ["PROMPTBOARD_MACHINE_TOKEN"]`,
        'Add this to ~/.codex/config.toml. env_vars passes PROMPTBOARD_MACHINE_TOKEN from the shell that starts Codex.'],
      other: [server({ PROMPTBOARD_MACHINE_TOKEN_FILE: '/path/to/a/file/only/you/can/read' }), 'Most MCP hosts take this JSON. Save the token in a file only you can read and name that file here, or set PROMPTBOARD_MACHINE_TOKEN in the host’s environment instead.'],
      rest: [`curl -s -H "Authorization: Bearer $PROMPTBOARD_MACHINE_TOKEN" ${url}/machine/v1/agents\n\ncurl -s -X POST -H "Authorization: Bearer $PROMPTBOARD_MACHINE_TOKEN" \\\n  -H "Content-Type: application/json" -H "Idempotency-Key: first-job" \\\n  -d '{"agentId":"agt_…","input":{"text":"Summarise the release notes."}}' \\\n  ${url}/machine/v1/jobs`,
        'Submit answers 202 with a jobId at once. Poll GET /machine/v1/jobs/<jobId>, then read GET /machine/v1/jobs/<jobId>/result. Send the same Idempotency-Key when you retry.'],
    };
  }

  function create(host) {
    const panel = el('section', 'network-panel network-clients'); panel.id = 'network-panel-settings'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'network-tab-settings'); panel.hidden = true;
    const state = { clients: [], agents: new Map(), networks: new Map(), status: null, error: '', loaded: false, host: 'claude' };
    let visible = false, version = 0;

    // ---- Machine listener
    const listenerStatus = el('p', 'network-clients-status'); listenerStatus.id = 'network-listener-status'; listenerStatus.setAttribute('role', 'status');
    const enabled = Object.assign(el('input', 'base-switch'), { type: 'checkbox' }); enabled.id = 'network-listener-enabled'; enabled.setAttribute('role', 'switch');
    const port = Object.assign(el('input'), { type: 'number', min: 1024, max: 65535, step: 1, inputMode: 'numeric' }); port.id = 'network-listener-port';
    const savePort = button('Save port', () => change({ port: Number(port.value) }), 'secondary-button'); savePort.id = 'network-listener-save';
    const switchLabel = el('label', 'network-clients-switch'); switchLabel.append(enabled, el('span', '', 'Listen for external clients'));
    const portRow = el('div', 'network-clients-port'); portRow.append(labelled('Port', port), savePort);
    const listenerCard = el('section', 'network-clients-card'); listenerCard.setAttribute('aria-labelledby', 'network-listener-heading');
    const listenerHeading = el('h3', '', 'Machine listener'); listenerHeading.id = 'network-listener-heading';
    listenerCard.append(listenerHeading, listenerStatus, el('div', 'network-clients-controls'), note('Only programs on this computer can connect (127.0.0.1). Turning it on and changing its port work only at this computer, not from a paired phone. It stays off until you turn it on.'));
    listenerCard.children[2].append(switchLabel, portRow);
    enabled.addEventListener('change', () => change({ enabled: enabled.checked }));
    port.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); savePort.click(); } });
    async function change(body) {
      if (body.port !== undefined && !(Number.isInteger(body.port) && body.port >= 1024 && body.port <= 65535)) { host.showError('Choose a port from 1024 to 65535.'); port.focus(); return; }
      const focused = document.activeElement;
      enabled.disabled = true; savePort.disabled = true; host.showError('');
      try {
        state.status = await host.request('/api/network/listener', { method: 'PATCH', body });
        const { listener } = state.status;
        host.say(listener.error ? listener.error : listener.listening ? `External clients can connect at ${listener.url}.` : 'The machine listener is off. No port is open.');
      } catch (failure) { host.showError(failure); }
      finally {
        enabled.disabled = false; savePort.disabled = false; renderListener(); renderSetup();
        if ([document.body, null].includes(document.activeElement)) focused?.focus?.(); // A disabled control lost focus: give it back.
      }
    }
    function renderListener() {
      const listener = state.status?.listener;
      if (!listener) { listenerStatus.textContent = state.error ? '' : 'Loading…'; return; }
      enabled.checked = listener.enabled;
      if (document.activeElement !== port) port.value = String(listener.port);
      listenerStatus.dataset.state = listener.error ? 'error' : listener.listening ? 'on' : 'off';
      listenerStatus.textContent = listener.error ? `Not listening: ${listener.error}` : listener.listening ? `On at ${listener.url}: this computer only.` : 'Off. No port is open, so no client can connect.';
    }

    // ---- Clients
    const createButton = button('Create client', () => openCreate(), 'secondary-button'); createButton.id = 'network-client-create';
    const clientsHead = el('div', 'network-clients-head'), clientsHeading = el('h3', '', 'Clients'); clientsHeading.id = 'network-clients-heading';
    clientsHead.append(clientsHeading, createButton);
    const list = el('ul', 'network-clients-list'); list.id = 'network-clients-list'; list.setAttribute('aria-labelledby', 'network-clients-heading');
    const empty = el('div', 'network-empty'); empty.id = 'network-clients-empty';
    const clientsCard = el('section', 'network-clients-card'); clientsCard.append(clientsHead, note('One client for each app or MCP host, so you can revoke one without the others. A client sees only the agents you give it and the jobs it submitted. It can never approve, retry or change anything.'), list, empty);
    const nameOf = id => state.agents.get(id)?.name || id;
    function clientRow(client) {
      const item = el('li', 'network-client'); item.dataset.clientId = client.id; item.dataset.status = client.status;
      const [label, tone] = STATES[client.status] || STATES.revoked;
      const head = el('div', 'network-client-head'), name = el('strong', '', client.name); name.id = `network-client-name-${client.id}`;
      head.append(name, el('small', `base-status tone-${tone}`, label));
      const facts = el('dl', 'network-facts');
      const fact = (term, value) => { facts.append(el('dt', '', term), el('dd', '', value)); };
      fact('Agents', client.scopes.agents.map(nameOf).join(', '));
      fact('May', client.scopes.permissions.map(id => PERMISSION_NAMES[id] || id).join(', '));
      fact('Projects', client.scopes.projects.length ? client.scopes.projects.map(id => host.projects().find(project => project.id === id)?.name || id).join(', ') : 'None');
      if (client.scopes.networks.length) fact('Networks', client.scopes.networks.map(id => state.networks.get(id) || id).join(', '));
      fact('Token', `pbm_…${client.tokenHint}`);
      fact('Created', `${when(client.createdAt)}${client.rotatedAt ? ` · token rotated ${ago(client.rotatedAt)}` : ''}`);
      fact('Last used', client.lastUsedAt ? ago(client.lastUsedAt) : 'Never');
      fact(client.revokedAt ? 'Revoked' : 'Expires', client.revokedAt ? when(client.revokedAt) : client.expiresAt ? when(client.expiresAt) : 'Never');
      item.append(head, facts);
      if (client.status === 'active') {
        const actions = el('div', 'detail-actions');
        const rotate = button('Rotate token', () => confirmAction(client, 'rotate'), 'secondary-button'); rotate.id = `network-client-rotate-${client.id}`; rotate.setAttribute('aria-describedby', name.id);
        const revoke = button('Revoke', () => confirmAction(client, 'revoke'), 'secondary-button network-danger'); revoke.id = `network-client-revoke-${client.id}`; revoke.setAttribute('aria-describedby', name.id);
        actions.append(rotate, revoke); item.append(actions);
      }
      return item;
    }
    function renderClients() {
      // Active clients first (newest first), then revoked and expired ones.
      list.replaceChildren(...state.clients.filter(client => client.status === 'active').concat(state.clients.filter(client => client.status !== 'active')).map(clientRow));
      empty.hidden = Boolean(state.clients.length) || !state.loaded;
      empty.replaceChildren(note(state.error ? 'Clients could not be loaded.' : 'No clients yet. Create one for each app or MCP host that should use your agents.'));
    }

    // ---- Setup snippets
    const setupHeading = el('h3', '', 'Connect an MCP host'); setupHeading.id = 'network-setup-heading';
    const hostSwitch = el('div', 'view-switch network-clients-hosts'); hostSwitch.setAttribute('role', 'group'); hostSwitch.setAttribute('aria-label', 'Setup for');
    for (const [id, label] of HOSTS) { const choice = button(label, () => { state.host = id; renderSetup(); }); choice.dataset.host = id; hostSwitch.append(choice); }
    const code = el('code'), snippet = el('pre', 'network-clients-snippet'); snippet.id = 'network-setup-snippet'; snippet.tabIndex = 0; snippet.setAttribute('aria-label', 'Setup snippet'); snippet.append(code);
    const snippetNote = note(''), copySnippet = button('Copy snippet', async () => {
      try { await navigator.clipboard.writeText(code.textContent); host.say('Copied the snippet. It holds no token.'); } catch { host.showError('The browser did not allow copying. Select the text and copy it.'); }
    }, 'secondary-button'); copySnippet.id = 'network-setup-copy';
    const setupCard = el('section', 'network-clients-card'); setupCard.setAttribute('aria-labelledby', 'network-setup-heading');
    setupCard.append(setupHeading, note('Give the token to the host as PROMPTBOARD_MACHINE_TOKEN in the environment that starts it. These snippets never contain a token.'), hostSwitch, snippet, snippetNote, copySnippet);
    function renderSetup() {
      for (const choice of hostSwitch.children) choice.setAttribute('aria-pressed', String(choice.dataset.host === state.host));
      if (!state.status) { code.textContent = ''; snippetNote.textContent = ''; return; }
      const [text, help] = snippets(state.status)[state.host];
      code.textContent = text; snippetNote.textContent = help;
    }

    const intro = note('Let apps and MCP hosts on this computer use your Network agents through jobs, each with its own token. They never get owner access: no Base, Kanban, approvals or settings.');
    const heading = el('h2', '', 'External clients'); heading.id = 'network-clients-title';
    const columns = el('div', 'network-clients-columns'), side = el('div', 'network-clients-side');
    side.append(listenerCard, setupCard); columns.append(clientsCard, side);
    // Task 12: the owner's handoff policy (network-delegation.js) lives in Settings too, below the external clients.
    const handoffs = window.PromptboardNetworkDelegation?.policyCard({ request: host.request, say: host.say, showError: host.showError }) || null;
    panel.append(heading, intro, columns, ...(handoffs ? [handoffs.node] : []));

    // ---- The dialog: its own, so a token never stays in the page after it closes.
    const dialog = el('dialog', 'kanban-dialog network-dialog network-clients-dialog'); dialog.id = 'network-clients-dialog'; dialog.setAttribute('aria-labelledby', 'network-clients-dialog-heading');
    document.body.append(dialog);
    let opener = null;
    function closeDialog() {
      if (dialog.open) dialog.close();
      dialog.replaceChildren(); // The token, if one was shown, leaves the page here.
      const back = opener; opener = null;
      (back?.isConnected ? back : back?.id && document.getElementById(back.id))?.focus?.();
    }
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDialog(); } });
    dialog.addEventListener('close', () => { if (dialog.childElementCount) closeDialog(); });
    function openDialog(title, nodes, focus) {
      opener = dialog.open ? opener : document.activeElement;
      const close = button('×', closeDialog, 'dialog-close icon-button'); close.setAttribute('aria-label', 'Close');
      const titleNode = el('h2', '', title); titleNode.id = 'network-clients-dialog-heading';
      dialog.replaceChildren(close, el('p', 'eyebrow', 'NETWORK'), titleNode, ...nodes);
      if (!dialog.open) dialog.showModal();
      (focus || titleNode).focus?.();
    }
    const failureLine = () => { const line = el('p', 'inline-error'); line.setAttribute('role', 'alert'); line.hidden = true; return line; };
    const showFailure = (line, failure) => { line.textContent = failure?.message || String(failure); line.hidden = false; };
    function checks(legend, options, checked, name) {
      const box = el('fieldset', 'settings-group network-clients-choices'); box.append(el('legend', '', legend));
      for (const [value, label, help] of options) {
        const input = Object.assign(el('input'), { type: 'checkbox', name, value, checked: checked.includes(value) }), row = el('label', 'network-clients-choice');
        row.append(input, el('span', '', label)); if (help) row.append(el('small', 'note', help));
        box.append(row);
      }
      box.values = () => [...box.querySelectorAll('input:checked')].map(input => input.value);
      return box;
    }

    /** One-time token view after create or rotate. Copy happens only on click; closing removes the token from the page. */
    function showToken(client, token, rotated) {
      const value = el('code', 'network-token-value', token); value.id = 'network-client-token'; value.tabIndex = 0; value.setAttribute('aria-label', 'Client token');
      const warning = el('p', 'network-token-warning', 'Copy it now: Promptboard will not show this token again. Only its hash is kept, so a lost token cannot be recovered; rotate it instead.'); warning.setAttribute('role', 'alert');
      const copy = button('Copy token', async () => {
        try { await navigator.clipboard.writeText(token); host.say('Token copied. Keep it out of shared files and chats.'); copy.textContent = 'Copied'; } catch { host.showError('The browser did not allow copying. Select the token and copy it.'); }
      }, 'secondary-button'); copy.id = 'network-client-token-copy';
      const done = button('Done', closeDialog, 'dialog-done'); done.id = 'network-client-token-done';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(copy, done);
      openDialog(rotated ? `New token for ${client.name}` : `${client.name} is ready`, [warning, value,
        note(rotated ? 'The previous token stopped working. Replace it wherever this client runs.' : 'Set it as PROMPTBOARD_MACHINE_TOKEN where the client runs, then use a setup snippet from this page.'), footer], value);
    }

    async function openCreate() {
      if (!state.agents.size) { openDialog('Create client', [note('Register an agent in Network first: a client can only use registered agents.'), (() => { const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Close', closeDialog, 'secondary-button')); return footer; })()]); return; }
      const form = el('form', 'network-form network-clients-form'); form.noValidate = true;
      const name = Object.assign(el('input'), { required: true, maxLength: 60, autocomplete: 'off', placeholder: 'For example: Claude Code on this Mac' }); name.id = 'network-client-name';
      const agents = checks('Agents it may use', [...state.agents.values()].map(agent => [agent.id, agent.name, agent.available ? '' : 'Cannot take jobs now (switched off or stale).']), [], 'agents');
      const permissions = checks('It may', PERMISSIONS, DEFAULT_PERMISSIONS, 'permissions');
      const projects = checks('Projects its jobs may name', host.projects().map(project => [project.id, project.name]), [], 'projects');
      if (!host.projects().length) projects.append(note('No projects on the board: its jobs name no project.'));
      const networks = checks('Networks its jobs may name', [...state.networks].map(([id, label]) => [id, label]), [], 'networks');
      const expiry = el('select'); expiry.id = 'network-client-expiry'; for (const [value, label] of EXPIRY) expiry.append(Object.assign(el('option', '', label), { value }));
      const failure = failureLine(), submit = Object.assign(el('button', 'dialog-done', 'Create client'), { type: 'submit' }); submit.id = 'network-client-submit';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', closeDialog, 'secondary-button'), submit);
      form.append(labelled('Name', name), agents, permissions, projects, ...(state.networks.size ? [networks] : []), labelled('Expires', expiry), failure, footer);
      form.addEventListener('submit', async event => {
        event.preventDefault(); failure.hidden = true;
        if (!name.value.trim()) { showFailure(failure, 'Name the client.'); name.focus(); return; }
        if (!agents.values().length) { showFailure(failure, 'Choose at least one agent.'); agents.querySelector('input')?.focus(); return; }
        if (!permissions.values().length) { showFailure(failure, 'Choose at least one permission.'); permissions.querySelector('input')?.focus(); return; }
        submit.disabled = true;
        try {
          const { client, token } = await host.request('/api/network/clients', { method: 'POST', body: { name: name.value.trim(), scopes: { agents: agents.values(), projects: projects.values(), networks: networks.values(), permissions: permissions.values() }, ...(expiry.value ? { expiresInDays: Number(expiry.value) } : {}) } });
          await load();
          showToken(client, token, false);
        } catch (error) { showFailure(failure, error); submit.disabled = false; }
      });
      openDialog('Create client', [form], name);
    }
    function confirmAction(client, action) {
      const rotate = action === 'rotate', failure = failureLine();
      const go = button(rotate ? 'Rotate token' : 'Revoke client', async () => {
        go.disabled = true; failure.hidden = true;
        try {
          if (rotate) { const { client: next, token } = await host.request(`/api/network/clients/${client.id}/rotate`, { method: 'POST', body: { expectedRevision: client.revision } }); await load(); showToken(next, token, true); return; }
          await host.request(`/api/network/clients/${client.id}`, { method: 'DELETE', body: {} });
          opener = createButton; closeDialog(); host.say(`${client.name} was revoked. Its token no longer works.`); await load();
        } catch (error) { showFailure(failure, error); go.disabled = false; }
      }, rotate ? 'dialog-done' : 'dialog-done network-danger');
      go.id = 'network-client-confirm';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', closeDialog, 'secondary-button'), go);
      openDialog(rotate ? `Rotate the token of ${client.name}?` : `Revoke ${client.name}?`, [
        note(rotate ? 'A new token is shown once. The current token stops working at once, also for open streams. Jobs it already submitted keep running and stay its own.'
          : 'Its token stops working at once and its open streams close. This cannot be undone. Jobs it already submitted keep running; cancel them in Activity if needed.'), failure, footer], go);
    }

    /** Every page of a list (`next` is the next offset): a client may be given any registered agent or network. */
    async function all(path, key) {
      const items = [];
      for (let offset = 0; offset !== null;) { const page = await host.request(`${path}?limit=200&offset=${offset}`); items.push(...page[key]); offset = page.next; }
      return items;
    }
    async function load() {
      const mine = ++version;
      try {
        const [clients, status, agents, networks] = await Promise.all([host.request('/api/network/clients'), host.request('/api/network/listener'), all('/api/network/agents', 'agents'),
          all('/api/network/networks', 'networks'), host.projects().length ? null : host.ensureBoard?.()?.catch?.(() => {})]);
        if (mine !== version) return;
        Object.assign(state, { clients: clients.clients, status, error: '', loaded: true, agents: new Map(agents.map(agent => [agent.id, { id: agent.id, name: agent.displayName || agent.base.name || agent.baseResourceId, available: agent.enabled && !agent.base.stale }])),
          networks: new Map(networks.map(network => [network.id, network.name])) });
      } catch (failure) { if (mine !== version) return; state.error = failure.message; state.loaded = true; host.showError(failure); }
      if (visible) render();
    }
    function render() { renderListener(); renderClients(); renderSetup(); }
    function show(on) {
      const entering = on && !visible; visible = on; panel.hidden = !on; handoffs?.show(on);
      if (!on) { if (dialog.open) { opener = null; closeDialog(); } return; } // A dialog never stays over another section.
      render();
      if (entering) void load();
    }
    return { panel, show };
  }
  return { create };
})();
