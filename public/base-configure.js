'use strict';

// Agent configuration owns no connections. It selects references from Base's MCP catalog.
window.PromptboardBaseConfigure = (() => {
  const el = (tag, text, cls = '') => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; n.className = cls; return n; };
  const note = text => el('p', text, 'note');
  const action = (text, fn, cls = 'secondary-button') => { const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const input = (value = '', type = 'text') => Object.assign(el('input'), { type, value });
  const area = (value = '', rows = 4) => Object.assign(el('textarea'), { value, rows, spellcheck: false, maxLength: 20000 });
  const select = (values, value) => { const n = el('select'); for (const [key, text] of values) n.add(new Option(text, key)); n.value = value; return n; };
  const field = (name, control, help) => { const n = el('label', undefined, 'field-label'); n.append(el('span', name), control); if (help) n.append(note(help)); return n; };
  const toggle = (name, checked, help) => { const n = input('', 'checkbox'); n.checked = checked; n.setAttribute('role', 'switch'); const row = field(name, n, help); row.classList.add('base-setting-toggle'); return { node: row, control: n }; };
  const section = (name, key, ...nodes) => { const n = el('fieldset', undefined, 'base-config-section'); n.dataset.agentSection = key; n.append(el('legend', name), ...nodes); return n; };
  const lines = text => text.split('\n').map(s => s.trim()).filter(Boolean);
  const changed = node => node.dispatchEvent(new Event('input', { bubbles: true }));

  function mcpPicker({ resources, references, onChange = () => {}, manage }) {
    const box = section('MCP connections', 'capabilities'), list = el('div', undefined, 'base-connection-selections');
    const picker = select([['', 'Select an enabled MCP connection…'], ...resources.filter(r => r.kind === 'mcp' && r.enabled && r.trust === 'trusted' && r.connectionTest?.status === 'connected').map(r => [r.id, r.name])], '');
    picker.className = 'base-mcp-select'; picker.setAttribute('aria-label', 'Add an enabled MCP connection');
    const render = () => {
      list.replaceChildren();
      const selected = references.filter(ref => resources.find(r => r.id === ref.resourceId)?.kind === 'mcp');
      for (const ref of selected) {
        const resource = resources.find(r => r.id === ref.resourceId), card = el('div', undefined, 'base-connection-selection'), head = el('div', undefined, 'base-config-row');
        const enabled = resource.enabled && resource.trust === 'trusted' && resource.connectionTest?.status === 'connected';
        head.append(el('strong', resource.name), el('span', enabled ? 'Available' : 'Unavailable', `base-config-badge ${enabled ? 'ok' : 'warn'}`), action('Remove', () => { references.splice(references.indexOf(ref), 1); render(); onChange(); changed(box); }, 'text-button'));
        const required = toggle('Required for this agent', ref.required !== false, 'A run stops before launch if a required connection cannot be supplied.');
        required.control.addEventListener('change', () => { ref.required = required.control.checked; onChange(); });
        card.append(head, required.node);
        const use = toggle('Use this connection in this agent', ref.enabled !== false); use.control.addEventListener('change', () => { if (use.control.checked) delete ref.enabled; else ref.enabled = false; onChange(); }); card.append(use.node);
        if (!enabled) card.append(note('This saved attachment is kept. Enable and trust the connection in Base → MCP before using it.'));
        const tools = resource.connectionTest?.tools || [];
        if (!tools.length) card.append(note(resource.connectionTest?.status === 'connected' ? 'The server reported no tools in its last connection test.' : 'Test this connection in Base → MCP to discover its tools.'));
        else {
          const policyNote = note(ref.allowedTools === undefined ? 'This existing attachment uses the server’s available tools. Choose tools below to create an explicit allowlist.' : 'Only selected tools are allowed. New tools added by the server stay off.'); card.append(policyNote);
          for (const tool of tools) {
            const globallyOff = (resource.configuration?.disabledTools || []).includes(tool.name);
            const permitted = !globallyOff && !(ref.disabledTools || []).includes(tool.name) && (ref.allowedTools === undefined || ref.allowedTools.includes(tool.name));
            const choice = toggle(tool.name, permitted, tool.description || ''); choice.control.disabled = globallyOff; choice.control.dataset.baseAllowedTool = tool.name;
            choice.control.addEventListener('change', () => {
              const names = ref.allowedTools === undefined ? tools.filter(t => !(resource.configuration?.disabledTools || []).includes(t.name) && !(ref.disabledTools || []).includes(t.name)).map(t => t.name) : [...ref.allowedTools];
              ref.allowedTools = choice.control.checked ? [...new Set([...names, tool.name])] : names.filter(name => name !== tool.name);
              policyNote.textContent = 'Only selected tools are allowed. New tools added by the server stay off.';
              const disabled = (ref.disabledTools || []).filter(name => name !== tool.name); if (disabled.length) ref.disabledTools = disabled; else delete ref.disabledTools; onChange(); changed(box);
            }); card.append(choice.node);
          }
        }
        list.append(card);
      }
      if (!selected.length) list.append(note('No MCP connections attached. Configure a connection once in Base → MCP, then reuse it here.'));
      for (const option of picker.options) option.disabled = selected.some(ref => ref.resourceId === option.value);
    };
    picker.addEventListener('change', () => { if (!picker.value) return; references.push({ resourceId: picker.value, required: true, allowedTools: [] }); picker.value = ''; render(); onChange(); changed(box); });
    box.append(note('Connections and authentication are managed in Base → MCP. Select an enabled connection, then choose the tools this agent needs.'), field('Add a connection', picker), list);
    if (manage) box.append(action('Manage MCP connections', manage, 'text-button'));
    render(); box.read = () => references.filter(ref => resources.find(r => r.id === ref.resourceId)?.kind === 'mcp'); return box;
  }

  function requirements({ item, form, request }) {
    const c = item.configuration.contract || {}, fresh = !item.id;
    const format = select([['text', 'Plain text'], ['markdown', 'Markdown report'], ['json', 'Structured JSON']], c.output?.format || 'markdown'); format.id = 'base-agent-output-format';
    const schema = area(c.output?.schema ? JSON.stringify(c.output.schema, null, 2) : '', 8); schema.id = 'base-agent-output-schema'; schema.placeholder = '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}';
    const schemaDetails = el('details', undefined, 'base-disclosure'); schemaDetails.append(el('summary', 'JSON schema (optional)'), field('Schema', schema, 'Supports types, properties, required, additionalProperties, items, enum/const and size/number limits. External references and executable rules are not accepted.'));
    const updateFormat = () => { schemaDetails.hidden = format.value !== 'json'; }; format.addEventListener('change', updateFormat); updateFormat();
    const contains = area((c.checks?.contains || []).join('\n'), 3), excludes = area((c.checks?.excludes || []).join('\n'), 3);
    contains.id = 'base-agent-required-text'; excludes.id = 'base-agent-excluded-text';
    const output = section('Output and checks', 'output', note('Define the answer your workflow expects. Checks run against the final answer; matching a schema does not establish factual accuracy.'), field('Answer format', format), schemaDetails,
      field('Must contain', contains, 'One exact phrase or heading per line.'), field('Must not contain', excludes, 'One exact phrase per line.'));
    const timeout = input(c.runtime?.timeoutMinutes || '', 'number'); timeout.min = '1'; timeout.max = '120'; timeout.placeholder = 'Use the execution default'; timeout.id = 'base-agent-timeout';
    const budget = input(c.runtime?.contextChars || '', 'number'); budget.min = '1000'; budget.max = '100000'; budget.placeholder = 'Use the context default'; budget.id = 'base-agent-context-limit';
    const target = select([['both', 'Kanban and Network'], ['kanban', 'Kanban only'], ['network', 'Network only']], c.runtime?.targets?.length === 1 ? c.runtime.targets[0] : 'both'); target.id = 'base-agent-target';
    const mcpMode = select([['base-only', 'Only connections selected through Base'], ['inherit', 'Also include connections configured in the CLI']], c.mcpMode || (fresh ? 'base-only' : 'inherit')); mcpMode.id = 'base-agent-mcp-mode';
    const policy = section('Execution policy', 'policy', field('Where this agent may run', target), field('MCP connections available during execution', mcpMode, 'This controls MCP connections. Other CLI tools remain subject to the chosen execution permissions.'), field('Maximum execution time (minutes)', timeout, 'An agent limit can shorten the job’s time limit. It cannot extend it.'), field('Maximum Base context (characters)', budget), note('Workspace, sandbox, approval and scheduling choices stay with the run. Token and price reports depend on the CLI; no hard spending cap is claimed.'));
    const memory = {};
    const knowledge = section('Memory permissions', 'knowledge', note('Choose which saved memory Network jobs may read. Each job must request these sources too. Project lessons and Network memory stay in their own stores.'));
    for (const [key, label] of [['agent', 'Allow this agent’s approved memory'], ['network', 'Allow approved network memory'], ['projectLessons', 'Allow approved project lessons']]) {
      memory[key] = toggle(label, c.memory?.[key] ?? !fresh); memory[key].control.dataset.baseMemory = key; knowledge.append(memory[key].node);
    }
    const cases = JSON.parse(JSON.stringify(c.evaluations || [])), caseList = el('div', undefined, 'base-test-cases');
    const renderCases = () => {
      caseList.replaceChildren();
      cases.forEach((test, index) => {
        const box = el('div', undefined, 'base-connection-selection'), name = input(test.name || ''), question = area(test.input || '', 3), expected = area((test.contains || []).join('\n'), 2), forbidden = area((test.excludes || []).join('\n'), 2);
        name.maxLength = 100; question.maxLength = 8000; name.addEventListener('input', () => { test.name = name.value; }); question.addEventListener('input', () => { test.input = question.value; }); expected.addEventListener('input', () => { test.contains = lines(expected.value); }); forbidden.addEventListener('input', () => { test.excludes = lines(forbidden.value); });
        box.append(field(`Test ${index + 1} · name`, name), field('Question', question), field('Expected text (one phrase per line)', expected), field('Prohibited text (one phrase per line)', forbidden), action('Remove test', () => { cases.splice(index, 1); renderCases(); changed(form); }, 'text-button')); caseList.append(box);
      });
    }; renderCases();
    const result = el('div', undefined, 'base-agent-test-result'); result.setAttribute('role', 'status');
    const prompt = area('', 3); prompt.id = 'base-agent-trial-question'; prompt.maxLength = 8000; prompt.placeholder = 'Ask a representative question to check this agent’s instructions and answer format.';
    const tests = section('Test the agent', 'test', note('Save your configuration before running a test. A model test uses the selected CLI and its quota. The preview shows which capabilities the test can exercise.'), caseList,
      action('Add test case', () => { if (cases.length < 10) { cases.push({ name: '', input: '', contains: [], excludes: [] }); renderCases(); changed(form); } }, 'text-button'), field('Try a question', prompt));
    let active = null;
    const cancel = action('Stop test', async () => { try { if (active) await request(`/api/base/resources/${item.id}/trial/cancel`, { method: 'POST', body: { operationId: active } }); } catch (error) { result.append(note(error.message)); } }); cancel.hidden = true;
    const run = action('Run test', async () => {
      result.replaceChildren(); if (!item.id || form.isDirty?.()) { result.append(note('Save the agent before running a test.')); return; }
      if (!prompt.value.trim() && !cases.length) { result.append(note('Enter a question or add a saved test case.')); prompt.focus(); return; }
      run.disabled = true; cancel.hidden = false; active = `base_trial_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
      try {
        const data = await request(`/api/base/resources/${item.id}/trial`, { method: 'POST', body: { expectedRevision: item.revision, operationId: active, question: prompt.value.trim() }, timeoutMs: 240000 });
        for (const item of data.results || []) {
          result.append(el('strong', `${item.name}: ${item.validation.passed ? 'Passed' : 'Failed'}`), el('pre', item.answer, 'base-trial-answer'));
          for (const error of item.validation.errors) result.append(note(error));
        }
        for (const message of data.coverage || []) result.append(note(message));
      } catch (error) { result.append(note(error.message)); }
      finally { run.disabled = false; cancel.hidden = true; active = null; }
    }); run.id = 'base-agent-run-test'; tests.append(run, cancel, result);
    const compatibility = el('div', undefined, 'base-compatibility-result'); compatibility.setAttribute('role', 'status');
    const inspect = action('Check compatibility', async () => {
      compatibility.replaceChildren();
      if (!item.id || form.isDirty?.()) { compatibility.append(note('Save the agent before checking compatibility.')); return; }
      inspect.disabled = true;
      try {
        const data = await request(`/api/base/resources/${item.id}/preflight`);
        const table = el('table', undefined, 'base-compatibility-table'), head = el('tr'); for (const name of ['CLI', 'Stage', 'Configuration']) head.append(el('th', name)); table.append(head);
        for (const row of data.matrix) {
          const tr = el('tr'); tr.append(el('td', { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }[row.provider]), el('td', row.columnId.replaceAll('_', ' ')));
          const cell = el('td'); cell.append(el('span', row.ready ? 'Ready' : 'Needs attention', `base-config-badge ${row.ready ? 'ok' : 'warn'}`));
          for (const issue of [...row.errors, ...row.warnings]) cell.append(note(issue.message)); tr.append(cell); table.append(tr);
        }
        compatibility.append(table, note(data.note));
      } catch (error) { compatibility.append(note(error.message)); } finally { inspect.disabled = false; }
    });
    tests.firstChild.after(inspect, compatibility);
    form.append(knowledge, output, policy, tests);
    return { read: () => ({ version: 1, mcpMode: mcpMode.value, output: { format: format.value, ...(format.value === 'json' && schema.value.trim() ? { schema: JSON.parse(schema.value) } : {}) }, checks: { contains: lines(contains.value), excludes: lines(excludes.value) },
      runtime: { targets: target.value === 'both' ? ['kanban', 'network'] : [target.value], ...(timeout.value ? { timeoutMinutes: Number(timeout.value) } : {}), ...(budget.value ? { contextChars: Number(budget.value) } : {}) }, memory: Object.fromEntries(Object.entries(memory).map(([key, value]) => [key, value.control.checked])), evaluations: cases }) };
  }

  function organize(form, item) {
    form.classList.add('base-configurator');
    const nodes = [...form.children], header = el('header', undefined, 'base-config-header'), rail = el('nav', undefined, 'base-config-nav'), body = el('div', undefined, 'base-config-body'), footer = el('div', undefined, 'base-config-footer');
    rail.setAttribute('aria-label', item.kind === 'mcp' ? 'MCP configuration sections' : 'Agent configuration sections');
    const mcp = item.kind === 'mcp';
    const groups = new Map(mcp ? [['connection', ['Connection', []]], ['authentication', ['Authentication', []]], ['activation', ['Tools and activation', []]], ['advanced', ['Details', []]]] : [['identity', ['Identity and model', []]], ['capabilities', ['Capabilities', []]], ['knowledge', ['Knowledge and memory', []]], ['output', ['Output and checks', []]], ['policy', ['Execution policy', []]], ['test', ['Test and compatibility', []]]]);
    header.append(el('p', mcp ? 'BASE / MCP CONNECTION' : item.kind === 'agentProfile' ? 'BASE / AGENT PROFILE' : 'BASE / AGENT', 'eyebrow'));
    for (const node of nodes) {
      if (node.tagName === 'H2') { header.append(node, note(mcp ? 'Connect once. Authenticate privately. Choose its tools and make it available to your agents.' : item.kind === 'agentProfile' ? 'Bring together a primary agent, selected capabilities and clear requirements.' : 'Give your specialist a purpose, the right capabilities and a clear definition of success.')); continue; }
      if (node.tagName === 'BUTTON' && /Back to library/.test(node.textContent)) { header.prepend(node); continue; }
      if (node.querySelector?.('#base-resource-save')) { footer.append(node); continue; }
      if (node.matches('.inline-error')) { footer.append(node); continue; }
      let key = node.dataset.agentSection;
      const legend = node.querySelector?.(':scope > legend')?.textContent || '';
      if (!key) key = mcp ? (node.tagName === 'DETAILS' || node.classList.contains('note') ? 'advanced' : 'connection') : /Base resources|Equipped resources|Agents/.test(legend) ? 'capabilities' : /What runs/.test(legend) ? 'test' : 'identity';
      groups.get(key)?.[1].push(node);
    }
    let first;
    for (const [key, [label, contents]] of groups) {
      const card = el('section', undefined, 'base-config-card'); card.id = `base-config-${key}`;
      const heading = el('h3', label); heading.tabIndex = -1; card.append(heading, ...contents); body.append(card);
      const go = action(label, () => { for (const b of rail.children) b.removeAttribute('aria-current'); go.setAttribute('aria-current', 'step'); card.scrollIntoView({ block: 'start', behavior: 'instant' }); heading.focus({ preventScroll: true }); }, 'base-config-nav-item');
      if (!first) { first = go; go.setAttribute('aria-current', 'step'); } rail.append(go);
    }
    form.replaceChildren(header, rail, body, footer);
  }
  function connection({ item, form, request, controls, remote }) {
    const cfg = item.configuration, { transport, endpoint, command, args, env, headers } = controls;
    const source = select([['link', 'MCP endpoint link'], ['json', 'JSON configuration'], ['command', 'Local server command']], cfg.transport === 'stdio' ? 'command' : 'link'); source.id = 'base-mcp-source';
    source.querySelector('option[value="json"]').disabled = Boolean(remote);
    const json = area('', 7); json.id = 'base-mcp-json'; json.maxLength = 1000000; json.placeholder = '{"mcpServers":{"my-server":{"url":"https://example.com/mcp"}}}';
    const file = input('', 'file'); file.accept = '.json,application/json'; file.setAttribute('aria-label', 'Load an MCP JSON configuration file');
    file.addEventListener('change', async () => { const f = file.files?.[0]; if (!f) return; if (f.size > 1000000) { jsonResult.replaceChildren(note('Choose a JSON file up to 1 MB.')); return; } json.value = await f.text(); changed(form); });
    const jsonResult = el('div'); jsonResult.setAttribute('role', 'status');
    const useJson = action('Review JSON configuration', async () => {
      jsonResult.replaceChildren();
      try {
        let value = JSON.parse(json.value); if (!value.mcpServers && !value.servers && (value.url || value.httpUrl || value.command)) value = { mcpServers: { 'MCP connection': value } };
        const data = await request('/api/base/mcp/import/preview', { method: 'POST', body: { json: JSON.stringify(value) } });
        for (const server of data.servers || []) {
          const row = el('div', undefined, 'base-connection-selection'); row.append(el('strong', server.name));
          for (const issue of server.issues || []) row.append(note(issue));
          if (server.duplicateOf) row.append(note(`Already configured as ${server.duplicateOf.name}. Reuse that connection from an agent.`));
          else if (server.importable) row.append(action('Use this server', () => {
            transport.value = server.transport; endpoint.value = server.endpoint || ''; command.value = server.command || ''; args.value = (server.args || []).join('\n');
            env.set(Object.fromEntries((server.env || []).map(ref => [ref.name, ref.reference]))); headers.set(Object.fromEntries((server.headers || []).map(ref => [ref.name, ref.reference])));
            const name = form.querySelector('#base-resource-name'); if (!name.value.trim()) name.value = server.name;
            transport.dispatchEvent(new Event('change')); changed(form); jsonResult.replaceChildren(note('Configuration applied to this draft. Review it and save. Credentials from pasted JSON were not copied.'));
          })); jsonResult.append(row);
        }
      } catch (error) { jsonResult.append(note(error.message)); }
    });
    const jsonBox = section('JSON configuration', 'connection', field('Paste JSON', json), file, useJson, jsonResult);
    const quick = section('Add a connection', 'connection', field('Setup method', source), note('Configure once here. Enabled connections can be reused by any agent without copying their settings.'));
    quick.id = 'base-mcp-quick-setup'; quick.append(jsonBox); form.append(quick);
    const update = () => { jsonBox.hidden = source.value !== 'json'; if (source.value !== 'json') { transport.value = source.value === 'command' ? 'stdio' : 'streamable-http'; transport.dispatchEvent(new Event('change')); } };
    source.addEventListener('change', update); if (!item.id) update(); else jsonBox.hidden = true;
    const method = select([['none', 'No authentication'], ['environment', 'API key or private credentials'], ['oauth', 'Sign in with the provider']], cfg.auth?.mode || (cfg.auth?.required || Object.keys(cfg.headers || {}).length || Object.keys(cfg.env || {}).length ? 'environment' : 'none')); method.id = 'base-mcp-auth-mode';
    const clientId = input(cfg.auth?.clientId || ''), scopes = input(cfg.auth?.scope || ''); clientId.maxLength = 512; scopes.maxLength = 2000;
    const options = el('details', undefined, 'base-disclosure'); options.append(el('summary', 'Provider OAuth options'), field('Client ID (when required by the provider)', clientId), field('Scopes (optional)', scopes));
    const auth = section('Authentication', 'authentication', field('Authentication method', method), options), status = el('div'); status.setAttribute('role', 'status');
    const credentials = el('div'), feedback = el('div'); feedback.setAttribute('role', 'status');
    const updateAuth = () => {
      options.hidden = method.value !== 'oauth';
      if (method.value === 'none') headers.set(Object.fromEntries(Object.entries(headers.read()).filter(([name]) => !/authorization|api[-_]?key|token/i.test(name))));
      if (method.value === 'environment' && transport.value === 'streamable-http' && !Object.keys(headers.read()).length) headers.set({ Authorization: 'PROMPTBOARD_MCP_AUTHORIZATION' });
      status.replaceChildren(note(item.id ? 'Save changes before connecting or changing authentication.' : 'Save this connection first, then configure credentials or sign in.'));
    }; method.addEventListener('change', updateAuth); updateAuth();
    let poll = null;
    const refresh = async () => {
      clearTimeout(poll); if (!item.id || !form.isConnected) return;
      try {
        const state = await request(`/api/base/resources/${item.id}/auth`), references = state.references || [], ready = references.every(reference => reference.ready);
        status.replaceChildren(el('span', state.pending ? 'Waiting for sign-in' : state.signedIn ? 'Signed in' : method.value === 'oauth' ? 'Sign-in required' : method.value === 'none' ? 'No authentication required' : references.length ? ready ? 'Credentials configured' : 'Credentials needed' : 'Add credential references to the connection', 'base-config-badge'));
        for (const reference of references) { const control = [...credentials.querySelectorAll('[data-reference]')].find(node => node.dataset.reference === reference.name); if (control) control.placeholder = reference.ready ? 'Already configured · leave blank to keep' : 'Enter private value'; }
        if (state.error) status.append(note(state.error));
        if (state.pending) poll = setTimeout(refresh, 1500);
      } catch (error) { status.replaceChildren(note(error.message)); }
    };
    const saveCredentials = action('Save credentials privately', async () => {
      feedback.replaceChildren();
      if (form.isDirty?.()) { feedback.append(note('Save the connection before updating credentials.')); return; }
      try { const values = Object.fromEntries([...credentials.querySelectorAll('input[data-reference]')].filter(n => n.value).map(n => [n.dataset.reference, n.value])); if (!Object.keys(values).length) { feedback.append(note('Enter a credential value first, or use Disconnect credentials to clear the connection.')); return; } await form.savedAction(() => request(`/api/base/resources/${item.id}/auth/credentials`, { method: 'POST', body: { expectedRevision: item.revision, values } }), () => note('Credentials saved privately. Test the connection again, then switch it on.')); }
      catch (error) { feedback.append(note(error.message)); }
    });
    const signIn = action('Sign in with provider', async () => {
      feedback.replaceChildren(); if (form.isDirty?.()) { feedback.append(note('Save the connection before signing in.')); return; }
      signIn.disabled = true;
      try { await form.savedAction(() => request(`/api/base/resources/${item.id}/auth/start`, { method: 'POST', body: { expectedRevision: item.revision }, timeoutMs: 60000 }), data => {
        const result = el('div'); result.append(note('Complete sign-in, then test the connection and switch it on.'));
        if (data.url) { const link = el('a', 'Continue to provider sign-in', 'text-link'); link.href = data.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; result.append(link); } return result;
      });
      } catch (error) { feedback.append(note(error.message)); } finally { signIn.disabled = false; }
    }); signIn.id = 'base-mcp-sign-in';
    const remove = action('Disconnect credentials', () => form.savedAction(() => request(`/api/base/resources/${item.id}/auth/disconnect`, { method: 'POST', body: {} }), () => note('Private credentials removed and this connection switched off. Existing running agents retain credentials already supplied.')), 'text-button');
    if (item.id && !remote) {
      for (const name of [...new Set([...Object.values(cfg.env || {}), ...Object.values(cfg.headers || {})])]) { const value = input('', 'password'); value.autocomplete = 'new-password'; value.dataset.reference = name; credentials.append(field(name, value, 'Enter a value to replace it; leave blank to keep the stored value. Authorization headers include the Bearer prefix when required.')); }
      if (cfg.auth?.mode === 'oauth' && cfg.auth?.clientId) { const value = input('', 'password'); value.dataset.reference = 'oauth_client_secret'; credentials.append(field('Client secret (only when required)', value)); }
      auth.append(credentials); if (credentials.childNodes.length) auth.append(saveCredentials);
      if (cfg.auth?.mode === 'oauth') auth.append(signIn);
      auth.append(remove); setTimeout(refresh, 0);
    } else if (remote) auth.append(note('Configure MCP sign-in and credentials on the computer running Promptboard.'));
    auth.append(status, feedback); form.append(auth);
    return { read: () => ({ mode: method.value, ...(method.value === 'oauth' && clientId.value.trim() ? { clientId: clientId.value.trim() } : {}), ...(method.value === 'oauth' && scopes.value.trim() ? { scope: scopes.value.trim() } : {}) }) };
  }
  return { organize, requirements, mcpPicker, connection };
})();
