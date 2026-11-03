'use strict';

// Network → Federation (docs/network/architecture.md §10.4, §24): controlled A2A with trusted remote agents. Two switches,
// both off until the owner turns them on: outbound (pipelines may call peers the owner approved) and inbound (A2A callers
// may submit tasks to agents the owner published for A2A, on the machine listener). A peer is added by previewing its
// Agent Card, reviewing what it says and approving exactly that card; its text is untrusted and is only ever set as text.
// A credential is named by its environment variable, never typed here. A caller's token appears once, in this module's
// own dialog, and leaves the page when the dialog closes. Every change here works only at this computer (the server
// refuses it from a paired phone); reading and removing a peer or a caller also work from a phone.
window.PromptboardNetworkFederation = (() => {
  const { el, button, plural, ago, errorLine, holdFocus } = window.PromptboardDom;
  const CALLER_PERMISSIONS = [
    ['submit_jobs', 'Send tasks', 'Each task becomes one read-only Network job of a published agent.'],
    ['read_job_result', 'Read results', 'A completed task carries the job’s result.'],
    ['cancel_own_jobs', 'Cancel its tasks', 'Cancel tasks it sent that have not ended.'],
    ['read_scoped_memory', 'Tasks may read memory', 'Its tasks may read the agent’s approved memory. Off: they get none.'],
  ];
  const DEFAULT_PERMISSIONS = ['submit_jobs', 'read_job_result', 'cancel_own_jobs'];
  const SCHEMES = { bearer: 'Bearer token', apiKey: 'API key', http: 'HTTP authentication', oauth2: 'OAuth 2.0', openIdConnect: 'OpenID Connect', mtls: 'Mutual TLS', unknown: 'Unknown' };
  const note = (text, className = 'note') => el('p', className, text);
  const labelled = (text, control, className = 'field-label') => { const label = el('label', className); label.append(text, control); return label; };
  const chip = (text, tone) => el('small', `base-status tone-${tone}`, text);
  const code = text => el('code', '', text);
  const facts = rows => { const list = el('dl', 'network-facts'); for (const [term, value] of rows) { const dd = el('dd'); dd.append(value); list.append(el('dt', '', term), dd); } return list; };
  const actionsRow = (...nodes) => { const box = el('div', 'kanban-dialog-actions'); box.append(...nodes); return box; };
  const schemeText = item => `${item.name}: ${SCHEMES[item.type] || item.type}${item.type === 'apiKey' ? ` in ${item.in}${item.header ? ` (${item.header})` : ''}` : ''}`;
  const credentialSchemes = card => card.securitySchemes.filter(item => item.type === 'bearer' || (item.type === 'apiKey' && item.header));

  function create(host) {
    const panel = el('section', 'network-panel network-clients network-federation'); panel.id = 'network-panel-federation'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'network-tab-federation'); panel.hidden = true;
    const state = { view: null, agents: [], callers: [], error: '', loaded: false };
    let visible = false, version = 0;
    const revision = () => state.view?.revision ?? 0;
    async function act(work, done) {
      host.showError('');
      try { await work(); if (done) host.say(done); } catch (failure) { host.showError(failure); }
      await load();
    }

    // ---- Remote peers (outbound)
    const outbound = Object.assign(el('input', 'base-switch'), { type: 'checkbox' }); outbound.id = 'network-federation-outbound'; outbound.setAttribute('role', 'switch');
    const outboundLabel = el('label', 'network-clients-switch'); outboundLabel.append(outbound, el('span', '', 'Call trusted remote peers'));
    const outboundStatus = el('p', 'network-clients-status'); outboundStatus.id = 'network-federation-outbound-status'; outboundStatus.setAttribute('role', 'status');
    outbound.addEventListener('change', () => act(() => host.request('/api/network/federation/outbound', { method: 'PATCH', body: { expectedRevision: revision(), enabled: outbound.checked } }),
      outbound.checked ? 'Outbound federation is on: pipelines may call the peers you trust.' : 'Outbound federation is off: no peer is contacted, and running remote jobs stop at once.'));
    const addPeer = button('Add peer…', () => openAddPeer(), 'secondary-button'); addPeer.id = 'network-federation-add-peer';
    const peersHeading = el('h3', '', 'Remote peers'); peersHeading.id = 'network-federation-peers-heading';
    const peersHead = el('div', 'network-clients-head'); peersHead.append(peersHeading, addPeer);
    const peers = el('ul', 'network-clients-list'); peers.id = 'network-federation-peers'; peers.setAttribute('aria-labelledby', 'network-federation-peers-heading');
    const peersEmpty = el('div', 'network-empty'); peersEmpty.id = 'network-federation-peers-empty';
    const peersCard = el('section', 'network-clients-card'); peersCard.setAttribute('aria-labelledby', 'network-federation-peers-heading');
    const switchRow = el('div', 'network-clients-controls'); switchRow.append(outboundLabel);
    peersCard.append(peersHead, outboundStatus, switchRow, note('A peer is an independent agent reached over A2A. Promptboard sees only what the protocol reports about its tasks, never its tools, memory or processes. Add it to a network in Graph, then use it as a remote peer step in a pipeline.'),
      note('What leaves this computer: a remote peer step sends the peer its instructions and what its arrows carry, over the internet. The peer may keep them; Promptboard cannot see or delete what it stores.', 'note network-privacy'), peers, peersEmpty);
    function peerRow(peer) {
      const item = el('li', 'network-client network-peer'); item.dataset.peerId = peer.id; item.dataset.status = peer.enabled ? 'active' : 'off';
      const head = el('div', 'network-client-head'), name = el('strong', '', peer.name); name.id = `network-peer-name-${peer.id}`;
      head.append(name, chip(peer.enabled ? 'Trusted' : 'Switched off', peer.enabled ? 'ok' : 'off'));
      if (peer.localTest) head.append(chip('Local test peer', 'warn'));
      const card = peer.card, credential = peer.credential;
      item.append(head, facts([
        ['Card', code(peer.cardUrl)], ['Endpoint', code(card.endpoint.url)], ['Protocol', `A2A ${card.endpoint.protocolVersion} · JSON-RPC · ${card.capabilities.streaming ? 'streams updates' : 'polled for updates'}`],
        ['Skills', card.skills.length ? card.skills.map(skill => skill.name || skill.id).join(', ') : 'None listed'],
        ['Security', card.securitySchemes.length ? card.securitySchemes.map(schemeText).join('; ') : 'None declared'],
        ['Credential', !credential ? 'None' : credential.renameNeeded ? `${credential.env} · rename it to PROMPTBOARD_A2A_…: until then its jobs are refused`
          : `${credential.env} (${credential.set ? 'set' : 'not set in this app’s environment'}) · ${credential.scheme}`],
        ...(peer.privateAddress ? [['Private address', code(peer.privateAddress)]] : []),
        ['Card checked', `${ago(peer.refreshedAt)} · sha256 ${peer.cardSha256.slice(0, 12)}`],
      ]));
      const actions = el('div', 'detail-actions');
      const mk = (label, run, key, className = 'secondary-button') => { const node = button(label, run, className); node.id = `network-peer-${key}-${peer.id}`; node.setAttribute('aria-describedby', name.id); actions.append(node); return node; };
      mk('Refresh card…', () => openPreview({ peer }), 'refresh');
      mk('Credential…', () => openCredential(peer), 'credential');
      mk(peer.enabled ? 'Switch off' : 'Switch on', () => act(() => host.request(`/api/network/federation/peers/${peer.id}`, { method: 'PATCH', body: { expectedRevision: peer.revision, enabled: !peer.enabled } }), `${peer.name} is switched ${peer.enabled ? 'off: its running jobs stopped' : 'on'}.`), 'toggle');
      mk('Remove…', () => confirmRemove(peer), 'remove', 'secondary-button network-danger');
      item.append(actions);
      return item;
    }

    // ---- Inbound A2A
    const inbound = Object.assign(el('input', 'base-switch'), { type: 'checkbox' }); inbound.id = 'network-federation-inbound'; inbound.setAttribute('role', 'switch');
    const inboundLabel = el('label', 'network-clients-switch'); inboundLabel.append(inbound, el('span', '', 'Accept A2A tasks'));
    const inboundStatus = el('p', 'network-clients-status'); inboundStatus.id = 'network-federation-inbound-status'; inboundStatus.setAttribute('role', 'status');
    const cardLine = el('div', 'network-federation-card-url'); cardLine.id = 'network-federation-card-url';
    inbound.addEventListener('change', () => act(() => host.request('/api/network/federation/inbound', { method: 'PATCH', body: { expectedRevision: revision(), enabled: inbound.checked } }),
      inbound.checked ? 'Inbound A2A is on for the agents you published.' : 'Inbound A2A is off: there is no Agent Card and no A2A endpoint.'));
    const publishHeading = el('h4', '', 'Published for A2A'); publishHeading.id = 'network-federation-publish-heading';
    const publishList = el('ul', 'network-federation-publish'); publishList.id = 'network-federation-publish'; publishList.setAttribute('aria-labelledby', 'network-federation-publish-heading');
    const savePublish = button('Save published agents', () => void savePublished(), 'secondary-button'); savePublish.id = 'network-federation-publish-save';
    const inboundHeading = el('h3', '', 'Inbound A2A'); inboundHeading.id = 'network-federation-inbound-heading';
    const inboundCard = el('section', 'network-clients-card'); inboundCard.setAttribute('aria-labelledby', 'network-federation-inbound-heading');
    const inboundControls = el('div', 'network-clients-controls'); inboundControls.append(inboundLabel);
    inboundCard.append(inboundHeading, inboundStatus, inboundControls, cardLine, note('Only agents you publish here are offered, each task runs as one read-only Network job, and callers need their own A2A token. It is served on the machine listener (Settings), on 127.0.0.1 only.'),
      publishHeading, publishList, savePublish);
    function publishRow(agent, entry) {
      const item = el('li', 'network-federation-publish-row'); item.dataset.agentId = agent.id;
      const on = Object.assign(el('input'), { type: 'checkbox', checked: Boolean(entry) }); on.id = `network-publish-${agent.id}`;
      const label = el('label', 'check-row'); label.append(on, el('span', '', agent.name));
      const description = Object.assign(el('input'), { type: 'text', maxLength: 300, value: entry?.description || '', placeholder: 'What callers read about it (one line)' }); description.id = `network-publish-description-${agent.id}`;
      const approval = Object.assign(el('input'), { type: 'checkbox', checked: Boolean(entry?.requireApproval) }); approval.id = `network-publish-approval-${agent.id}`;
      const approvalLabel = el('label', 'check-row'); approvalLabel.append(approval, el('span', '', 'Each task waits for my approval'));
      item.append(label, labelled('Description for callers', description), approvalLabel);
      if (!agent.available) item.append(note('Switched off or stale: not offered until it can take work.', 'network-stale'));
      item.read = () => (on.checked ? { agentId: agent.id, description: description.value.trim(), requireApproval: approval.checked } : null);
      return item;
    }
    async function savePublished() {
      const agents = [...publishList.children].map(item => item.read?.()).filter(Boolean);
      await act(() => host.request('/api/network/federation/inbound', { method: 'PATCH', body: { expectedRevision: revision(), agents } }), `${plural(agents.length, 'agent')} published for A2A.`);
    }

    // ---- A2A callers (machine clients of kind a2a)
    const createCaller = button('Create caller…', () => openCreateCaller(), 'secondary-button'); createCaller.id = 'network-federation-create-caller';
    const callersHeading = el('h3', '', 'A2A callers'); callersHeading.id = 'network-federation-callers-heading';
    const callersHead = el('div', 'network-clients-head'); callersHead.append(callersHeading, createCaller);
    const callers = el('ul', 'network-clients-list'); callers.id = 'network-federation-callers'; callers.setAttribute('aria-labelledby', 'network-federation-callers-heading');
    const callersCard = el('section', 'network-clients-card'); callersCard.setAttribute('aria-labelledby', 'network-federation-callers-heading');
    callersCard.append(callersHead, note('One caller for each outside agent, so you can revoke one without the others. A caller can only send tasks to the published agents you give it and read its own tasks.'), callers);
    function callerRow(client) {
      const item = el('li', 'network-client'); item.dataset.clientId = client.id; item.dataset.status = client.status;
      const head = el('div', 'network-client-head'), name = el('strong', '', client.name); name.id = `network-caller-name-${client.id}`;
      head.append(name, chip({ active: 'Active', revoked: 'Revoked', expired: 'Expired' }[client.status] || client.status, client.status === 'active' ? 'ok' : 'off'));
      const agentName = id => state.agents.find(agent => agent.id === id)?.name || id;
      item.append(head, facts([['Agents', client.scopes.agents.map(agentName).join(', ')], ['May', client.scopes.permissions.map(id => CALLER_PERMISSIONS.find(([key]) => key === id)?.[1] || id).join(', ')],
        ['Token', `pbm_…${client.tokenHint}`], ['Last used', client.lastUsedAt ? ago(client.lastUsedAt) : 'Never']]));
      if (client.status === 'active') {
        const revoke = button('Revoke', () => confirmRevoke(client), 'secondary-button network-danger'); revoke.id = `network-caller-revoke-${client.id}`; revoke.setAttribute('aria-describedby', name.id);
        const actions = el('div', 'detail-actions'); actions.append(revoke); item.append(actions);
      }
      return item;
    }

    const heading = el('h2', '', 'Federation'); heading.id = 'network-federation-title';
    const intro = note('Work with trusted remote agents over A2A, and let trusted outside agents use the agents you publish. Both directions stay off until you turn them on.');
    const columns = el('div', 'network-clients-columns'), side = el('div', 'network-clients-side');
    side.append(inboundCard, callersCard); columns.append(peersCard, side);
    panel.append(heading, intro, columns);

    // ---- The dialog: this module's own, so a caller's token never stays in the page after it closes.
    const dialog = el('dialog', 'kanban-dialog network-dialog network-clients-dialog network-federation-dialog'); dialog.id = 'network-federation-dialog'; dialog.setAttribute('aria-labelledby', 'network-federation-dialog-heading');
    document.body.append(dialog); holdFocus(dialog);
    let opener = null;
    function closeDialog() {
      if (dialog.open) dialog.close();
      dialog.replaceChildren();
      const back = opener; opener = null;
      (back?.isConnected ? back : back?.id && document.getElementById(back.id))?.focus?.();
    }
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDialog(); } });
    // A close event can arrive after the dialog was opened again (it is queued): only a dialog that is really closed is cleared.
    dialog.addEventListener('close', () => { if (!dialog.open && dialog.childElementCount) closeDialog(); });
    function openDialog(title, nodes, focus) {
      opener = dialog.open ? opener : document.activeElement;
      const close = button('×', closeDialog, 'dialog-close icon-button'); close.setAttribute('aria-label', 'Close');
      const titleNode = el('h2', '', title); titleNode.id = 'network-federation-dialog-heading'; titleNode.tabIndex = -1;
      dialog.replaceChildren(close, el('p', 'eyebrow', 'FEDERATION'), titleNode, ...nodes);
      if (!dialog.open) dialog.showModal();
      (focus || titleNode).focus?.();
    }
    const failureLine = () => { const line = el('p', 'inline-error'); line.setAttribute('role', 'alert'); line.hidden = true; return line; };
    const showFailure = (line, failure) => { line.textContent = failure?.message || String(failure); line.hidden = false; };

    /** Add a peer: the address and how it may be reached, then a preview to review. */
    function openAddPeer() {
      const form = el('form', 'network-form'); form.noValidate = true;
      const url = Object.assign(el('input'), { type: 'url', required: true, placeholder: 'https://agent.example.com/.well-known/agent-card.json', autocomplete: 'off', maxLength: 2048 }); url.id = 'network-peer-url';
      const local = Object.assign(el('input'), { type: 'checkbox' }); local.id = 'network-peer-local';
      const localLabel = el('label', 'check-row'); localLabel.append(local, el('span', '', 'Local test peer: plain http:// to this computer only (127.0.0.1, ::1, localhost)'));
      const privateAddress = Object.assign(el('input'), { type: 'text', placeholder: 'Optional, for example 10.0.0.5', autocomplete: 'off', maxLength: 45 }); privateAddress.id = 'network-peer-private';
      const failure = failureLine(), submit = Object.assign(el('button', 'dialog-done', 'Preview card'), { type: 'submit' }); submit.id = 'network-peer-preview';
      form.append(labelled('Agent Card URL', url), localLabel, labelled('Private network address it may use (https only)', privateAddress),
        note('Previewing fetches the card once, over https, from a public address unless you allow one here. Nothing is saved until you approve what you saw.'), failure, actionsRow(button('Cancel', closeDialog, 'secondary-button'), submit));
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!url.value.trim()) { showFailure(failure, 'Enter the card’s URL.'); url.focus(); return; }
        void openPreview({ url: url.value.trim(), localTest: local.checked, privateAddress: privateAddress.value.trim() || undefined, failure, submit });
      });
      openDialog('Add a remote peer', [form], url);
    }
    /** The review: everything the card says, as text, and what Promptboard will keep; approve keeps exactly this card. */
    async function openPreview({ peer = null, url, localTest = false, privateAddress, failure = null, submit = null }) {
      const target = peer ? { url: peer.cardUrl, localTest: peer.localTest, ...(peer.privateAddress ? { privateAddress: peer.privateAddress } : {}) } : { url, localTest, ...(privateAddress ? { privateAddress } : {}) };
      if (submit) submit.disabled = true;
      let preview;
      try { ({ preview } = await host.request('/api/network/federation/peers/preview', { method: 'POST', body: target })); } catch (error) {
        if (failure) { showFailure(failure, error); submit.disabled = false; return; }
        openDialog(`Refresh ${peer.name}`, [errorLine(error.message), actionsRow(button('Close', closeDialog, 'secondary-button'))]); return;
      }
      const card = preview.card, same = peer && peer.cardSha256 === preview.cardSha256;
      const origin = url => new URL(url).origin, moved = peer && origin(card.endpoint.url) !== origin(peer.card.endpoint.url);
      const review = el('div', 'network-form network-peer-review'); review.id = 'network-peer-review';
      const skills = el('ul', 'network-federation-skills'); skills.setAttribute('aria-label', 'Skills the card lists');
      for (const skill of card.skills) { const item = el('li'); item.append(el('strong', '', skill.name || skill.id), ...(skill.description ? [el('span', 'network-row-sub', skill.description)] : [])); skills.append(item); }
      const warnings = el('ul', 'network-federation-warnings'); warnings.id = 'network-peer-warnings'; for (const text of preview.warnings) warnings.append(el('li', '', text));
      review.append(note(peer ? (same ? 'The card is unchanged since you approved it.' : 'The card changed since you approved it. Review it before you keep the new one.') : 'Review what the card says. Everything below is the peer’s own text, shown as text.', peer && !same ? 'network-stale' : 'note'),
        facts([['Name', card.name], ['Origin', code(preview.origin)], ['Endpoint', code(card.endpoint.url)], ['Protocol', `A2A ${card.endpoint.protocolVersion} · JSON-RPC · ${card.capabilities.streaming ? 'streams updates' : 'polled for updates'}`],
          ['Provider', card.provider || 'Not given'], ['Version', card.version || 'Not given'], ['Security', card.securitySchemes.length ? card.securitySchemes.map(schemeText).join('; ') : 'None declared'],
          ['Card sha256', code(preview.cardSha256.slice(0, 16))]]),
        ...(card.description ? [el('h4', '', 'Description'), el('p', 'network-federation-description', card.description)] : []),
        el('h4', '', `Skills (${card.skills.length})`), card.skills.length ? skills : note('None listed.'), el('h4', '', 'Notes'), warnings);
      const usable = credentialSchemes(card), failureBox = failureLine();
      const env = Object.assign(el('input'), { type: 'text', placeholder: 'For example PROMPTBOARD_A2A_ACME_TOKEN', autocomplete: 'off', maxLength: 64, value: moved ? '' : peer?.credential?.env || '' }); env.id = 'network-peer-env';
      const scheme = el('select'); scheme.id = 'network-peer-scheme';
      for (const item of usable) scheme.append(Object.assign(el('option', '', schemeText(item)), { value: item.name }));
      if (peer?.credential && usable.some(item => item.name === peer.credential.scheme)) scheme.value = peer.credential.scheme;
      // A refresh shows the credential too: a card that moves the endpoint to another origin does not take the credential along.
      review.append(el('h4', '', 'Credential'), ...(moved ? [note(`The endpoint moved from ${origin(peer.card.endpoint.url)} to ${origin(card.endpoint.url)}. The credential is not sent there unless you name it again here.`, 'network-stale')] : []),
        usable.length ? labelled('Environment variable that holds it', env) : note('The card declares no bearer or header API-key scheme, so no credential is sent.'),
        ...(usable.length ? [labelled('Scheme', scheme), note('Promptboard keeps only this name, which starts with PROMPTBOARD_A2A_, and reads the value from its environment at each call. It is sent only to the endpoint’s own origin.')] : []));
      const named = () => env.value.trim(), credentialChanged = () => Boolean(usable.length) && (moved ? Boolean(named()) : named() !== (peer.credential?.env || '') || Boolean(named() && scheme.value !== peer.credential?.scheme));
      const approve = button(peer ? (same ? 'Keep it' : 'Keep the new card') : 'Approve and trust', async () => {
        approve.disabled = true; failureBox.hidden = true;
        try {
          if (peer) await host.request(`/api/network/federation/peers/${peer.id}`, { method: 'PATCH', body: { expectedRevision: peer.revision, cardSha256: preview.cardSha256, ...(credentialChanged() ? { credentialEnv: named() || null, credentialScheme: scheme.value } : {}) } });
          else await host.request('/api/network/federation/peers', { method: 'POST', body: { ...target, cardSha256: preview.cardSha256, expectedRevision: revision(), ...(env.value.trim() ? { credentialEnv: env.value.trim(), credentialScheme: scheme.value } : {}) } });
          opener = addPeer; closeDialog(); host.say(peer ? `Checked the card of ${card.name}.` : `${card.name} is a trusted peer. Add it to a network in Graph to use it in a pipeline.`); await load();
        } catch (error) { showFailure(failureBox, error); approve.disabled = false; }
      }, 'dialog-done'); approve.id = 'network-peer-approve';
      openDialog(peer ? `Refresh ${peer.name}` : `Review ${card.name}`, [review, failureBox, actionsRow(button('Cancel', closeDialog, 'secondary-button'), approve)], approve);
    }
    function openCredential(peer) {
      const usable = credentialSchemes(peer.card), failure = failureLine();
      if (!usable.length) { openDialog(`Credential for ${peer.name}`, [note('Its card declares no bearer or header API-key scheme, so no credential is sent.'), actionsRow(button('Close', closeDialog, 'secondary-button'))]); return; }
      const env = Object.assign(el('input'), { type: 'text', maxLength: 64, autocomplete: 'off', value: peer.credential?.env || '', placeholder: 'PROMPTBOARD_A2A_…, or empty: send none' }); env.id = 'network-peer-credential-env';
      const scheme = el('select'); scheme.id = 'network-peer-credential-scheme'; for (const item of usable) scheme.append(Object.assign(el('option', '', schemeText(item)), { value: item.name }));
      if (peer.credential) scheme.value = peer.credential.scheme;
      const save = button('Save', async () => {
        save.disabled = true; failure.hidden = true;
        try { await host.request(`/api/network/federation/peers/${peer.id}`, { method: 'PATCH', body: { expectedRevision: peer.revision, credentialEnv: env.value.trim() || null, credentialScheme: scheme.value } }); closeDialog(); host.say(`Saved the credential reference of ${peer.name}.`); await load(); }
        catch (error) { showFailure(failure, error); save.disabled = false; }
      }, 'dialog-done'); save.id = 'network-peer-credential-save';
      openDialog(`Credential for ${peer.name}`, [labelled('Environment variable that holds it', env), labelled('Scheme', scheme), note('Only the variable’s name is kept. It starts with PROMPTBOARD_A2A_, so no other variable of this app (a provider’s key, PATH) can be sent to a peer. Never paste the credential itself.'), failure, actionsRow(button('Cancel', closeDialog, 'secondary-button'), save)], env);
    }
    function confirmRemove(peer) {
      const failure = failureLine(), go = button('Remove peer', async () => {
        go.disabled = true;
        try { await host.request(`/api/network/federation/peers/${peer.id}`, { method: 'DELETE', body: { expectedRevision: peer.revision } }); opener = addPeer; closeDialog(); host.say(`${peer.name} is no longer trusted.`); await load(); }
        catch (error) { showFailure(failure, error); go.disabled = false; }
      }, 'dialog-done network-danger'); go.id = 'network-peer-remove-confirm';
      openDialog(`Remove ${peer.name}?`, [note('Promptboard stops trusting it: running jobs for it stop at once and end unknown, queued jobs fail before anything is sent, and Graph and pipelines show it as missing. Tasks it already accepted may go on at the peer.'), failure, actionsRow(button('Cancel', closeDialog, 'secondary-button'), go)], go);
    }
    function openCreateCaller() {
      const published = (state.view?.inbound.agents || []).filter(entry => !entry.missing);
      if (!published.length) { openDialog('Create an A2A caller', [note('Publish at least one agent for A2A first: a caller can only use published agents.'), actionsRow(button('Close', closeDialog, 'secondary-button'))]); return; }
      const form = el('form', 'network-form'); form.noValidate = true;
      const name = Object.assign(el('input'), { required: true, maxLength: 60, autocomplete: 'off', placeholder: 'For example: Partner research agent' }); name.id = 'network-caller-name';
      const box = (legend, options, checked, key) => {
        const set = el('fieldset', 'settings-group network-clients-choices'); set.append(el('legend', '', legend));
        for (const [value, label, help] of options) { const input = Object.assign(el('input'), { type: 'checkbox', name: key, value, checked: checked.includes(value) }), row = el('label', 'network-clients-choice'); row.append(input, el('span', '', label)); if (help) row.append(el('small', 'note', help)); set.append(row); }
        set.values = () => [...set.querySelectorAll('input:checked')].map(input => input.value);
        return set;
      };
      const agents = box('Published agents it may use', published.map(entry => [entry.agentId, entry.name || entry.agentId, entry.available ? '' : 'Cannot take tasks now.']), published.length === 1 ? [published[0].agentId] : [], 'agents');
      const permissions = box('It may', CALLER_PERMISSIONS, DEFAULT_PERMISSIONS, 'permissions');
      const failure = failureLine(), submit = Object.assign(el('button', 'dialog-done', 'Create caller'), { type: 'submit' }); submit.id = 'network-caller-submit';
      form.append(labelled('Name', name), agents, permissions, failure, actionsRow(button('Cancel', closeDialog, 'secondary-button'), submit));
      form.addEventListener('submit', async event => {
        event.preventDefault(); failure.hidden = true;
        if (!name.value.trim()) { showFailure(failure, 'Name the caller.'); name.focus(); return; }
        if (!agents.values().length) { showFailure(failure, 'Choose at least one agent.'); agents.querySelector('input')?.focus(); return; }
        submit.disabled = true;
        try {
          const { client, token } = await host.request('/api/network/clients', { method: 'POST', body: { kind: 'a2a', name: name.value.trim(), scopes: { agents: agents.values(), permissions: permissions.values() } } });
          await load(); showToken(client, token);
        } catch (error) { showFailure(failure, error); submit.disabled = false; }
      });
      openDialog('Create an A2A caller', [form], name);
    }
    /** The caller's token, once: copied only on click, gone from the page when the dialog closes. */
    function showToken(client, token) {
      const value = el('code', 'network-token-value', token); value.id = 'network-caller-token'; value.tabIndex = 0; value.setAttribute('aria-label', 'Caller token');
      const warning = el('p', 'network-token-warning', 'Copy it now: Promptboard will not show this token again. Only its hash is kept.'); warning.setAttribute('role', 'alert');
      const copy = button('Copy token', async () => { try { await navigator.clipboard.writeText(token); host.say('Token copied. Give it to the caller over a private channel.'); copy.textContent = 'Copied'; } catch { host.showError('The browser did not allow copying. Select the token and copy it.'); } }, 'secondary-button'); copy.id = 'network-caller-token-copy';
      const done = button('Done', closeDialog, 'dialog-done'); done.id = 'network-caller-token-done';
      const where = state.view?.inbound.endpoint || 'http://127.0.0.1:<listener port>/a2a/v1';
      openDialog(`${client.name} is ready`, [warning, value, note(`The caller sends it as Authorization: Bearer <token> to ${where}, after reading the Agent Card${state.view?.inbound.cardUrl ? ` at ${state.view.inbound.cardUrl}` : ''}.`), actionsRow(copy, done)], value);
    }
    function confirmRevoke(client) {
      const failure = failureLine(), go = button('Revoke caller', async () => {
        go.disabled = true;
        try { await host.request(`/api/network/clients/${client.id}`, { method: 'DELETE', body: {} }); opener = createCaller; closeDialog(); host.say(`${client.name} was revoked. Its token no longer works.`); await load(); }
        catch (error) { showFailure(failure, error); go.disabled = false; }
      }, 'dialog-done network-danger'); go.id = 'network-caller-revoke-confirm';
      openDialog(`Revoke ${client.name}?`, [note('Its token stops working at once. Tasks it already sent keep running; cancel them in Activity if needed.'), failure, actionsRow(button('Cancel', closeDialog, 'secondary-button'), go)], go);
    }

    function render() {
      const view = state.view;
      window.PromptboardDom.recoveryNotice(panel, view?.recovery);
      if (!view) { outboundStatus.textContent = state.error ? 'Federation could not be loaded.' : 'Loading…'; inboundStatus.textContent = ''; return; }
      outbound.checked = view.outbound.enabled;
      outboundStatus.dataset.state = view.outbound.enabled ? 'on' : 'off';
      outboundStatus.textContent = view.outbound.enabled ? `On: pipelines may call ${plural(view.peers.filter(peer => peer.enabled).length, 'trusted peer')}.` : 'Off: Promptboard contacts no peer, and previews and remote steps are refused.';
      addPeer.disabled = !view.outbound.enabled; addPeer.title = view.outbound.enabled ? '' : 'Turn outbound federation on first.';
      const focusKeep = panel.contains(document.activeElement) ? document.activeElement.id : null; // Only the panel's own controls are redrawn.
      peers.replaceChildren(...view.peers.map(peerRow));
      peersEmpty.hidden = Boolean(view.peers.length);
      peersEmpty.replaceChildren(note(view.outbound.enabled ? 'No trusted peer yet. Add one by its Agent Card URL.' : 'No trusted peer. Turn outbound federation on, then add a peer by its Agent Card URL.'));
      inbound.checked = view.inbound.enabled;
      const { listener } = view.inbound;
      inboundStatus.dataset.state = view.inbound.serving ? 'on' : 'off';
      inboundStatus.textContent = !view.inbound.enabled ? 'Off: there is no Agent Card and no A2A endpoint.' : !listener.listening ? 'On, but the machine listener is off: turn it on in Network → Settings.'
        : view.inbound.serving ? 'On: A2A callers can reach the agents you published, on this computer only.' : 'On, but no published agent can take tasks, so nothing is offered.';
      cardLine.replaceChildren(...(view.inbound.cardUrl ? [el('span', 'note', 'Agent Card: '), code(view.inbound.cardUrl), el('span', 'note', ' · endpoint '), code(view.inbound.endpoint)] : []));
      const entries = new Map(view.inbound.agents.map(entry => [entry.agentId, entry]));
      publishList.replaceChildren(...state.agents.map(agent => publishRow(agent, entries.get(agent.id))));
      if (!state.agents.length) publishList.append(el('li', 'note', 'No agents are registered yet. Register Base agents in Network → Agents first.'));
      savePublish.disabled = !state.agents.length;
      callers.replaceChildren(...state.callers.map(callerRow));
      if (!state.callers.length) callers.append(el('li', 'note', 'No A2A callers yet.'));
      if (focusKeep && document.activeElement?.id !== focusKeep) document.getElementById(focusKeep)?.focus?.(); // Redrawn rows keep their IDs.
    }
    async function load() {
      const mine = ++version;
      try {
        const [view, agents, clients] = await Promise.all([host.request('/api/network/federation'), host.request('/api/network/agents?limit=200'), host.request('/api/network/clients')]);
        if (mine !== version) return;
        Object.assign(state, { view, error: '', loaded: true, agents: agents.agents.map(agent => ({ id: agent.id, name: agent.displayName || agent.base.name || agent.baseResourceId, available: agent.enabled && !agent.base.stale })),
          callers: [...clients.clients.filter(client => client.kind === 'a2a' && client.status === 'active'), ...clients.clients.filter(client => client.kind === 'a2a' && client.status !== 'active')] });
      } catch (failure) { if (mine !== version) return; state.error = failure.message; state.loaded = true; host.showError(failure); }
      if (visible) render();
    }
    function show(on) {
      const entering = on && !visible; visible = on; panel.hidden = !on;
      if (!on) { if (dialog.open) { opener = null; closeDialog(); } return; }
      render();
      if (entering) void load();
    }
    return { panel, show };
  }
  return { create };
})();
