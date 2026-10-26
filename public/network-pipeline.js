'use strict';

// Network → Pipelines (docs/network/architecture.md §9, §20, §21): the pipelines of each network, a designer for one draft
// and a viewer for one run. A pipeline is an execution DAG that pins a published network version: its arrows are
// execution order and carry results along typed ports (agent text|json, sub-pipeline text, condition true|false, the
// others done). They are a different kind of edge from Graph relations (permissions and intent, which move no data) and
// look different: solid right-angled arrows with port labels and step shapes per type, against dashed relation curves.
// Draft → Validate → Publish an immutable version → Run an explicit version. Saving, validating and publishing start
// nothing; only the confirmed Run starts a run, and a run keeps the plan of the version it pinned whatever the draft
// becomes. The canvas is Cytoscape on wide screens (the same CSP-safe setup as Graph); the step and arrow lists beside it
// do everything with the keyboard, and a phone gets only the ordered lists and one step's details.
window.PromptboardNetworkPipeline = (() => {
  const { el, button, plural, ago, clip, download } = window.PromptboardDom;
  const { note, labelled, select, chip, randomHex, isPhone, clone, debounce, css, keepFocus } = window.PromptboardNetworkGraph.kit;
  const TYPES = [['agent', 'Agent'], ['subnetwork', 'Sub-network'], ['parallel', 'Parallel'], ['join', 'Join'], ['condition', 'Condition'], ['approval', 'Approval'], ['output', 'Output']];
  const TYPE_NAMES = Object.fromEntries(TYPES);
  const MARKS = { agent: '◉', subnetwork: '⧉', parallel: '⫘', join: '⋈', condition: '◇', approval: '✋', output: '▤' };
  const HELP = {
    agent: 'Runs one registered agent of the pinned network version as a Network job. It receives only what its incoming arrows carry.',
    subnetwork: 'Runs a published pipeline of a network this network contains, pinned at one version. It passes on that pipeline’s report text.',
    parallel: 'Starts the steps after it at the same time and passes on what reached it.',
    join: 'Waits for the steps before it (all of them, or the first that arrives) and passes on what reached it.',
    condition: 'Checks the json results of steps before it with fixed rules, then goes on along “true” or “false”.',
    approval: 'Waits for your Approve or Reject. Nothing after it runs until you decide.',
    output: 'Saves a report of the steps you tick, in order. It ends the pipeline: no arrow leaves it.',
  };
  // The ports each step type sends on (every arrow arrives on `input`), as src/network/pipeline-model.mjs enforces them.
  const PORTS = { agent: ['text', 'json'], subnetwork: ['text'], condition: ['true', 'false'], parallel: ['done'], join: ['done'], approval: ['done'], output: [] };
  const PORT_NAMES = { text: 'text result', json: 'json result', true: 'when true', false: 'when false', done: 'when done' };
  const OPERATORS = [['eq', 'equals'], ['ne', 'does not equal'], ['lt', 'is less than'], ['lte', 'is at most'], ['gt', 'is more than'], ['gte', 'is at least'], ['in', 'is one of'], ['exists', 'exists'], ['contains', 'contains']];
  const VALUE_TYPES = [['text', 'Text'], ['number', 'Number'], ['boolean', 'True or false'], ['null', 'Null']];
  const STEP_STATES = { pending: ['Waiting', 'off'], ready: ['Ready', 'off'], running: ['Running', 'run'], waiting_for_approval: ['Waiting for you', 'warn'], blocked: ['Blocked', 'warn'],
    completed: ['Completed', 'ok'], failed: ['Failed', 'error'], skipped: ['Skipped', 'off'], cancelled: ['Cancelled', 'off'] };
  const RUN_STATES = { running: ['Running', 'run'], waiting_for_approval: ['Waiting for your approval', 'warn'], blocked: ['Blocked', 'warn'], interrupted: ['Interrupted', 'warn'],
    completed: ['Completed', 'ok'], failed: ['Failed', 'error'], cancelled: ['Cancelled', 'off'] };
  const MOVING = new Set(['running', 'waiting_for_approval', 'blocked']);
  const RULE_PATH = /^(n_[0-9a-f]{12})\.json((?:\.[A-Za-z0-9_-]{1,64}){0,8})$/, FIELD = /^[A-Za-z0-9_-]{1,64}$/, STEM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
  const SEMANTICS = 'Pipeline arrows are execution order: a step runs after the steps whose arrows reach it and receives only what those arrows carry. They are not Graph relations, which record permissions and intent and never move data. Saving, validating and publishing start nothing; only Run starts a run.';
  const POLL_MS = 1000, UNDO_DEPTH = 50, LIST_PAGE = 200, SETTINGS = 'settings';
  const COST = 'Not enforced, and unknown before it runs: Promptboard cannot estimate it, and tokens and cost are not limited during the run.';
  const tone = ([text, kind]) => chip(text, kind);
  const newId = (prefix, taken) => { let id; do id = `${prefix}_${randomHex()}`; while (taken.has(id)); taken.add(id); return id; };

  /** Execution order (Kahn) of `ids` along `links` ([from, to]); steps on a loop come last, in their given order. */
  function topo(ids, links) {
    const count = new Map(ids.map(id => [id, 0])), next = new Map(ids.map(id => [id, []]));
    for (const [from, to] of links) if (count.has(from) && count.has(to)) { count.set(to, count.get(to) + 1); next.get(from).push(to); }
    const queue = ids.filter(id => !count.get(id));
    for (const id of queue) for (const to of next.get(id)) { count.set(to, count.get(to) - 1); if (!count.get(to)) queue.push(to); }
    const seen = new Set(queue);
    return [...queue, ...ids.filter(id => !seen.has(id))];
  }
  /** Columns along the execution order (a step's column is its longest path from a start), rows within each column. */
  function layered(ids, links, { x = 0, y = 0, dx = 220, dy = 104 } = {}) {
    const column = new Map(ids.map(id => [id, 0]));
    for (const id of topo(ids, links)) for (const [from, to] of links) if (from === id && column.has(to)) column.set(to, Math.max(column.get(to), column.get(id) + 1));
    const rows = new Map(), at = new Map();
    for (const id of ids) { const c = column.get(id), row = rows.get(c) || 0; rows.set(c, row + 1); at.set(id, { x: x + c * dx, y: y + row * dy }); }
    return at;
  }
  /**
   * What can reach each step along the arrows (the compiler's typing, architecture §20 item 3): an agent passes its result
   * on the port the arrow leaves from, a sub-pipeline and an output their report text, every other step what reached it.
   */
  function reaching(nodes, edges) {
    const byId = new Map(nodes.map(node => [node.id, node])), into = new Map(nodes.map(node => [node.id, []])), reach = new Map();
    for (const edge of edges) into.get(edge.to)?.push(edge);
    for (const id of topo(nodes.map(node => node.id), edges.map(edge => [edge.from, edge.to]))) {
      const seen = new Set(), list = [];
      for (const edge of into.get(id)) {
        const from = byId.get(edge.from); if (!from) continue;
        for (const ref of from.type === 'agent' ? [{ node: edge.from, port: edge.fromPort }] : ['subnetwork', 'output'].includes(from.type) ? [{ node: edge.from, port: 'text' }] : reach.get(edge.from) || []) {
          const key = `${ref.node}>${ref.port}`; if (!seen.has(key)) { seen.add(key); list.push(ref); }
        }
      }
      reach.set(id, list);
    }
    return reach;
  }
  /** True when an arrow from → to would close a loop (to already leads to from). */
  function loops(edges, from, to) {
    const next = new Map(); for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) || []), edge.to]);
    const stack = [to], seen = new Set();
    while (stack.length) { const id = stack.pop(); if (id === from) return true; if (seen.has(id)) continue; seen.add(id); stack.push(...(next.get(id) || [])); }
    return false;
  }
  /** A condition rule as the editor shows it: step, fields, operator, value type and the typed text. */
  function ruleDraft(rule) {
    const match = RULE_PATH.exec(rule?.path || ''), sample = Array.isArray(rule?.value) ? rule.value[0] : rule?.value;
    const type = sample === null ? 'null' : typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'text';
    return { step: match?.[1] || '', fields: match?.[2] ? match[2].slice(1) : '', op: rule?.op || 'eq', type, raw: rule && rule.op !== 'exists' ? (Array.isArray(rule.value) ? rule.value.map(String).join(', ') : rule.value === null ? '' : String(rule.value)) : '' };
  }
  /** The stored rule of an editor row, or `{ error }` saying what to fix (the server checks the same; architecture §20 item 2). */
  function ruleOf(draft) {
    if (!draft.step) return { error: 'Choose the step whose json result the rule reads.' };
    const fields = draft.fields.trim() ? draft.fields.trim().split('.') : [];
    if (fields.length > 8 || !fields.every(field => FIELD.test(field))) return { error: 'Fields are names or list positions separated by dots: letters, digits, _ and -, at most 8.' };
    const path = `${draft.step}.json${fields.length ? `.${fields.join('.')}` : ''}`;
    if (draft.op === 'exists') return { rule: { path, op: 'exists' } };
    const typed = (text, type) => {
      const value = text.trim();
      if (type === 'number' || ['lt', 'lte', 'gt', 'gte'].includes(draft.op)) { const number = value === '' ? NaN : Number(value); return Number.isFinite(number) ? { value: number } : { error: 'Write a number.' }; }
      if (type === 'boolean') return /^(true|false)$/i.test(value) ? { value: value.toLowerCase() === 'true' } : { error: 'Write true or false.' };
      if (type === 'null') return { value: null };
      return text.length <= 1000 ? { value: text } : { error: 'Text holds at most 1,000 characters.' };
    };
    if (draft.op === 'in') {
      const items = draft.raw.split(',').map(item => item.trim()).filter(Boolean);
      if (!items.length || items.length > 50) return { error: 'Write 1 to 50 values, separated by commas.' };
      const values = items.map(item => typed(item, draft.type)), bad = values.find(item => item.error);
      return bad ? { error: bad.error } : { rule: { path, op: 'in', value: values.map(item => item.value) } };
    }
    const one = typed(draft.raw, draft.type);
    return one.error ? { error: one.error } : { rule: { path, op: draft.op, value: one.value } };
  }
  /** What changed from one published version to the next, in words (steps by ID, arrows by their ends and port). */
  function diffOf(before, after) {
    if (!before) return 'This is the first version.';
    const steps = list => new Map(list.map(node => [node.id, node])), a = steps(before.nodes), b = steps(after.nodes);
    const added = [...b.keys()].filter(id => !a.has(id)), removed = [...a.keys()].filter(id => !b.has(id));
    const changed = [...b.keys()].filter(id => a.has(id) && JSON.stringify([a.get(id).type, a.get(id).label, a.get(id).config]) !== JSON.stringify([b.get(id).type, b.get(id).label, b.get(id).config]));
    const arrow = edge => `${edge.from}>${edge.fromPort}>${edge.to}`, x = new Set(before.edges.map(arrow)), y = new Set(after.edges.map(arrow));
    const parts = [added.length && `${plural(added.length, 'step')} added`, removed.length && `${plural(removed.length, 'step')} removed`, changed.length && `${plural(changed.length, 'step')} changed`,
      [...y].filter(key => !x.has(key)).length && `${plural([...y].filter(key => !x.has(key)).length, 'arrow')} added`, [...x].filter(key => !y.has(key)).length && `${plural([...x].filter(key => !y.has(key)).length, 'arrow')} removed`,
      JSON.stringify(before.settings) !== JSON.stringify(after.settings) && 'settings changed', before.networkVersion !== after.networkVersion && `network version ${before.networkVersion} → ${after.networkVersion}`,
      before.name !== after.name && 'renamed'].filter(Boolean);
    return parts.length ? `Compared with version ${before.number}: ${parts.join(', ')}.` : `Compared with version ${before.number}: only positions changed.`;
  }
  /** The steps a refused save, validate or publish points at (`details.nodeId`, `path`, `include`, `missing`) and its edge. */
  function marksOf(failure, nodes) {
    const details = failure?.details || {}, present = new Set(nodes.map(node => node.id)), top = id => (typeof id === 'string' ? id.split('/')[0] : null);
    const ids = [top(details.nodeId), ...(Array.isArray(details.path) ? details.path.map(top) : []), top(details.include)].filter(id => present.has(id));
    return { nodes: new Set(ids), edges: new Set(details.edgeId ? [details.edgeId] : []) };
  }
  /** The live source of an open run view, swappable in one place (host.followRun): calls `changed()` until it answers false. */
  function pollRun(runId, changed) {
    let timer = null, stopped = false;
    const next = () => { timer = setTimeout(async () => { if (stopped) return; let again = true; try { again = await changed(); } catch {} if (again !== false && !stopped) next(); }, POLL_MS); };
    next();
    return () => { stopped = true; clearTimeout(timer); };
  }

  function create(host) {
    const { request, say, go } = host;
    const followRun = host.followRun || pollRun; // Task 08's event stream replaces the polling here (architecture §21).
    let current = null; // { section: 'pipelines', pipelineId?, runId? } while this section shows, otherwise null.
    const cache = new Map(); // Published versions never change: `kind:id@n` → promise.
    const cached = (key, load) => { if (!cache.has(key)) cache.set(key, load().catch(failure => { cache.delete(key); throw failure; })); return cache.get(key); };
    const networkVersion = (id, n) => cached(`net:${id}@${n}`, () => request(`/api/network/networks/${id}/versions/${n}`));
    const pipelineVersion = (id, n) => cached(`pip:${id}@${n}`, async () => (await request(`/api/network/pipelines/${id}/versions/${n}`)).version);

    function closeActions(...extra) { const box = el('div', 'kanban-dialog-actions'); box.append(button('Close', host.closeDialog, 'secondary-button'), ...extra); return box; }
    /** A confirmation: `action` runs on the button and closes the dialog itself; a failure stays in the dialog. */
    function ask(title, nodes, label, action, { danger = false } = {}) {
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const confirm = button(label, async () => {
        confirm.disabled = true; failure.hidden = true;
        try { await action(); } catch (error) { failure.replaceChildren(el('span', '', error.message)); failure.hidden = false; } finally { confirm.disabled = false; }
      }, `secondary-button${danger ? ' network-danger' : ''}`);
      confirm.id = 'network-confirm';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', host.closeDialog, 'secondary-button'), confirm);
      const body = el('div', 'network-form'); body.append(...nodes, failure, footer);
      host.openDialog(title, [body]);
      confirm.focus();
    }
    /** A form in the dialog: `fields` are [label, control]; `onSubmit` closes it; a failure stays in it. */
    function formDialog(title, intro, fields, submitLabel, onSubmit, submitId = 'network-pipeline-form-submit') {
      const form = el('form', 'network-form'); form.noValidate = true;
      if (intro) form.append(note(intro));
      form.append(...fields);
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const submit = el('button', 'dialog-done', submitLabel); submit.type = 'submit'; submit.id = submitId;
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', host.closeDialog, 'secondary-button'), submit);
      form.append(failure, footer);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (submit.disabled) return; submit.disabled = true; failure.hidden = true;
        try { await onSubmit(); } catch (error) { failure.replaceChildren(el('span', '', error.message)); failure.hidden = false; } finally { submit.disabled = false; }
      });
      host.openDialog(title, [form]);
      form.querySelector('input, select, textarea')?.focus();
      return { form, submit, failure };
    }
    const textInput = (id, value = '', max = 80) => { const input = Object.assign(el('input'), { type: 'text', maxLength: max, value, autocomplete: 'off' }); input.id = id; return input; };

    // ---- The panel: the list of pipelines, the designer of one draft, or the viewer of one run.
    const panel = el('section', 'network-panel network-graph-panel network-pipelines'); panel.id = 'network-panel-pipelines';
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'network-tab-pipelines'); panel.hidden = true;
    const semantics = note(SEMANTICS, 'note network-inert network-pipeline-semantics'); semantics.id = 'network-pipeline-semantics';
    const listView = el('section', 'network-pipeline-list-view'); listView.id = 'network-pipelines-view';
    const designer = el('section', 'network-graph network-pipeline-designer'); designer.id = 'network-pipeline-designer';
    const runView = el('section', 'network-graph network-run-view'); runView.id = 'network-run-view';
    panel.append(semantics, listView, designer, runView);

    // ---- List: every pipeline (by network), create, rename, duplicate, delete; the latest runs. Read on every visit.
    const lst = { items: [], total: 0, next: null, unavailable: [], loaded: false, loading: false, error: '', q: '', networkId: '', networks: [], runs: [], version: 0, focus: null };
    const lSearch = Object.assign(el('input'), { type: 'search', placeholder: 'Find a pipeline…', autocomplete: 'off', maxLength: 200 }); lSearch.id = 'network-pipelines-search';
    const lNetwork = select([['', 'All networks']]); lNetwork.id = 'network-pipelines-network';
    const lNew = button('New pipeline…', () => newDialog(false), 'secondary-button'); lNew.id = 'network-pipelines-new';
    const lTemplate = button('New from template…', () => newDialog(true), 'secondary-button'); lTemplate.id = 'network-pipelines-template';
    const lTools = el('div', 'network-toolbar network-library-tools'), lButtons = el('div', 'network-library-buttons'); lButtons.append(lNew, lTemplate);
    lTools.append(labelled('Search pipelines', lSearch, 'field-label network-search'), labelled('Network', lNetwork), lButtons);
    const lCount = note('', 'note network-count'), lList = el('ul', 'network-list'); lList.id = 'network-pipelines-list'; lList.setAttribute('aria-label', 'Pipelines');
    const lEmpty = el('div', 'network-empty'), lMore = button('Show more pipelines', () => loadList({ append: true }), 'secondary-button network-more'); lMore.hidden = true;
    const lRuns = el('ul', 'network-list'); lRuns.id = 'network-pipelines-runs'; lRuns.setAttribute('aria-label', 'Latest runs');
    const lRunsTitle = el('h3', 'network-pipeline-subtitle', 'Latest runs');
    listView.append(el('h2', 'network-pipeline-title', 'Pipelines'), lTools, lCount, lList, lEmpty, lMore, lRunsTitle, lRuns);
    lSearch.addEventListener('input', debounce(() => { if (lst.q !== lSearch.value.trim()) { lst.q = lSearch.value.trim(); void loadList(); } }, 250));
    lNetwork.addEventListener('change', () => { lst.networkId = lNetwork.value; void loadList(); });

    async function loadList({ append = false } = {}) {
      const version = ++lst.version;
      lst.loading = true; if (!append) lst.error = '';
      renderList();
      const params = new URLSearchParams({ limit: '200', offset: String(append ? lst.items.length : 0) });
      if (lst.q) params.set('q', lst.q); if (lst.networkId) params.set('networkId', lst.networkId);
      try {
        const [data, networks, runs] = await Promise.all([request(`/api/network/pipelines?${params}`), append ? null : request('/api/network/networks?limit=200&archived=true'), append ? null : request('/api/network/pipeline-runs?limit=20')]);
        if (version !== lst.version) return;
        Object.assign(lst, { items: append ? [...lst.items, ...data.pipelines] : data.pipelines, total: data.total, next: data.next, unavailable: data.unavailable || [], loaded: true });
        if (networks) lst.networks = networks.networks;
        if (runs) lst.runs = runs.runs;
      } catch (failure) { if (version === lst.version) lst.error = failure.message; }
      finally { if (version === lst.version) { lst.loading = false; renderList(); } }
    }
    const networkName = id => lst.networks.find(item => item.id === id)?.name || id;
    function renderList() {
      if (!current || current.pipelineId || current.runId) return;
      const options = [['', 'All networks'], ...lst.networks.map(item => [item.id, `${item.name}${item.archived ? ' (archived)' : ''}`])];
      if ([...lNetwork.options].map(option => option.value).join('\n') !== options.map(([id]) => id).join('\n')) { lNetwork.replaceChildren(...select(options).children); lNetwork.value = lst.networkId; }
      listView.setAttribute('aria-busy', String(lst.loading || !lst.loaded));
      keepFocus(listView, () => lList.replaceChildren(...(lst.error ? [] : lst.items.map(pipelineRow))));
      lCount.hidden = !lst.loaded || Boolean(lst.error) || !lst.items.length;
      lCount.textContent = lst.total > lst.items.length ? `${lst.items.length} of ${plural(lst.total, 'pipeline')}` : plural(lst.total, 'pipeline');
      lEmpty.replaceChildren(); lEmpty.hidden = lst.loaded && !lst.error && lst.items.length > 0;
      if (!lst.loaded && !lst.error) lEmpty.append(note('Loading pipelines…'));
      else if (lst.error) { const failure = el('p', 'inline-error', `Could not load pipelines. ${lst.error}`); failure.setAttribute('role', 'alert'); lEmpty.append(failure, button('Retry', () => loadList(), 'secondary-button')); }
      else if (!lst.items.length && (lst.q || lst.networkId)) lEmpty.append(note('No pipelines match.'), button('Clear search', () => { lst.q = ''; lst.networkId = ''; lSearch.value = ''; lNetwork.value = ''; void loadList(); }, 'secondary-button'));
      else if (!lst.items.length) lEmpty.append(el('p', 'network-empty-title', 'No pipelines yet.'), note('A pipeline runs the agents of a published network version in an order you draw: parallel research, a join, a review, your approval and a saved report. Start from the template to see one.'));
      if (lst.unavailable.length) { lEmpty.append(note(`${plural(lst.unavailable.length, 'saved pipeline')} cannot be read and ${lst.unavailable.length === 1 ? 'is' : 'are'} left out. Nothing was changed.`, 'note network-stale')); lEmpty.hidden = false; }
      lMore.hidden = !lst.loaded || Boolean(lst.error) || lst.next === null;
      const names = new Map(lst.items.map(item => [item.id, item.name]));
      keepFocus(listView, () => lRuns.replaceChildren(...lst.runs.map(run => runRow(run, names.get(run.pipelineId)))));
      if (!lst.runs.length) lRuns.append(el('li', 'note', lst.loaded ? 'No runs yet. Publish a pipeline, then Run it.' : ''));
      if (lst.focus) { (lList.querySelector(`[data-pipeline-id="${lst.focus}"]`) || lNew).focus(); lst.focus = null; }
    }
    function pipelineRow(item) {
      const row = el('li', 'network-row network-pipeline-row'), latest = item.publishedVersions.at(-1);
      const open = button('', () => go(`#/network/pipelines/${item.id}`), 'network-agent'); open.dataset.pipelineId = item.id;
      const icon = el('span', 'base-kind-icon network-graph-icon', '⇶'); icon.setAttribute('aria-hidden', 'true');
      const text = el('span', 'network-row-text');
      text.append(el('strong', '', item.name), el('span', 'network-row-sub', `${networkName(item.networkId)} · network version ${item.networkVersion} · ${plural(item.stepCount, 'step')} · ${plural(item.edgeCount, 'arrow')}`),
        chip(latest ? `Version ${latest.version} latest` : 'Not published', latest ? 'ok' : 'off'));
      open.append(icon, text);
      const actions = el('div', 'network-record-actions network-pipeline-row-actions');
      const act = (label, run, name) => { const node = button(label, run, 'text-button'); node.dataset.action = `${name}-${item.id}`; node.setAttribute('aria-label', `${label.replace('…', '')} “${item.name}”`); actions.append(node); return node; };
      act('Rename…', () => renameDialog(item), 'rename'); act('Duplicate…', () => duplicateDialog(item), 'duplicate');
      const remove = act('Delete…', () => deleteDialog(item), 'delete'); remove.classList.add('network-danger-text');
      if (item.publishedVersions.length) { remove.disabled = true; remove.title = 'It has published versions, which runs and other pipelines may pin, so it cannot be deleted.'; }
      row.append(open, actions);
      return row;
    }
    function runRow(run, pipelineName) {
      const row = el('li', 'network-row'), open = button('', () => go(`#/network/runs/${run.id}`), 'network-agent'); open.dataset.runId = run.id;
      const text = el('span', 'network-row-text'), counts = run.steps || {}, total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      text.append(el('strong', '', `${pipelineName || 'Pipeline'} · version ${run.pipelineVersion}`), el('span', 'network-row-sub', `Started ${ago(run.startedAt)} · ${counts.completed || 0} of ${plural(total, 'step')} completed`), tone(RUN_STATES[run.status] || [run.status, 'off']));
      const icon = el('span', 'base-kind-icon network-graph-icon', '▶'); icon.setAttribute('aria-hidden', 'true');
      open.append(icon, text); row.append(open);
      return row;
    }
    /** The members of a published network version: its agents (with their names and state as the version's refs show them). */
    async function membersOf(networkId, number) {
      const data = await networkVersion(networkId, number);
      return { version: data.version, refs: data.refs, agents: data.version.nodes.filter(node => node.type === 'agent').map(node => ({ id: node.agentId, name: data.refs.agents?.[node.agentId]?.name || node.agentId, ref: data.refs.agents?.[node.agentId] || null })),
        subs: data.version.nodes.filter(node => node.type === 'subnetwork').map(node => ({ networkId: node.networkId, version: node.version, name: data.refs.networks?.[node.networkId]?.name || node.networkId })) };
    }
    /** New pipeline (empty) or from the MVP template, for a published network version. */
    async function newDialog(template) {
      const title = template ? 'New pipeline from a template' : 'New pipeline';
      if (!lst.loaded) await loadList();
      const usable = lst.networks.filter(item => !item.archived && item.publishedVersions.length);
      if (!usable.length) {
        host.openDialog(title, [note('A pipeline pins a published network version, and no network is published yet. Add agents to a network in Graph and publish it first.'), closeActions(button('Open Graph', () => { host.closeDialog(); go('#/network/graph'); }, 'secondary-button'))]);
        return;
      }
      const name = textInput('network-pipeline-name-input', template ? 'Research report' : '');
      const network = select(usable.map(item => [item.id, item.name])); network.id = 'network-pipeline-network-input';
      network.value = usable.some(item => item.id === lst.networkId) ? lst.networkId : usable[0].id;
      const version = el('select'); version.id = 'network-pipeline-version-input';
      const description = Object.assign(el('textarea'), { rows: 3, maxLength: 2000 }); description.id = 'network-pipeline-description-input';
      const roles = template ? [['a', 'Research A'], ['b', 'Research B'], ['review', 'Reviewer']].map(([key, label]) => { const pick = el('select'); pick.id = `network-template-${key}`; return [key, label, pick]; }) : [];
      const members = note(''); members.id = 'network-pipeline-members'; members.setAttribute('aria-live', 'polite');
      const fields = [labelled('Name', name), labelled('Network', network), labelled('Pinned network version', version), members, ...(template ? roles.map(([, label, pick]) => labelled(label, pick)) : [labelled('Description (optional)', description)])];
      const intro = template ? 'The template is the demo shape: two research steps run at the same time, a join waits for both, a reviewer reads them, you approve, and the report is saved. It becomes a normal draft you edit; nothing runs.'
        : 'A new, empty draft. It pins one published version of the network: its steps may use only that version’s agents.';
      const { submit } = formDialog(title, intro, fields, 'Create', async () => {
        const body = { networkId: network.value, networkVersion: Number(version.value), name: name.value.trim(), ...(template ? mvp(...roles.map(([, , pick]) => pick.value)) : { description: description.value.trim() }) };
        const data = await request('/api/network/pipelines', { method: 'POST', body });
        host.closeDialog(); say(`Created “${data.pipeline.name}”. ${template ? 'Change its steps and agents, then validate and publish it.' : 'Add steps from the palette, then save the draft.'} Nothing runs.`);
        go(`#/network/pipelines/${data.pipeline.id}`);
      });
      let turn = 0;
      const fillMembers = async () => {
        const mine = ++turn; members.textContent = 'Loading its agents…'; submit.disabled = true;
        try {
          const found = await membersOf(network.value, Number(version.value)); if (mine !== turn) return;
          members.textContent = found.agents.length ? `${plural(found.agents.length, 'agent')} in this version: ${found.agents.map(agent => agent.name).join(', ')}.` : 'This version has no agents. Add agents in Graph and publish a new version first.';
          roles.forEach(([, , pick], index) => { pick.replaceChildren(...select(found.agents.map(agent => [agent.id, agent.name])).children); pick.value = found.agents[Math.min(index, found.agents.length - 1)]?.id || ''; });
          submit.disabled = template && !found.agents.length;
        } catch (failure) { if (mine === turn) members.textContent = `Could not read this version. ${failure.message}`; }
      };
      const fillVersions = () => { const item = usable.find(entry => entry.id === network.value); version.replaceChildren(...select([...item.publishedVersions].reverse().map(entry => [String(entry.version), `Version ${entry.version}${entry === item.publishedVersions.at(-1) ? ' (latest)' : ''}`])).children); void fillMembers(); };
      network.addEventListener('change', fillVersions); version.addEventListener('change', () => void fillMembers());
      fillVersions();
    }
    /** The MVP demo (NETWORK_REQUIREMENTS "MVP demonstration" 3): research A ∥ research B → join → reviewer → approval → report. */
    function mvp(a, b, review) {
      const taken = new Set(), [ra, rb, join, check, gate, out] = Array.from({ length: 6 }, () => newId('n', taken));
      const agent = (agentId, instructions) => ({ agentId, instructions, tools: 'none', timeoutMs: null, retries: 0 });
      const nodes = [
        { id: ra, type: 'agent', label: 'Research A', config: agent(a, 'Research the topic in the run input. Report what you found and where it comes from.') },
        { id: rb, type: 'agent', label: 'Research B', config: agent(b, 'Research the same topic from another angle: risks, competitors and open questions.') },
        { id: join, type: 'join', label: 'Both researched', config: { require: 'all' } },
        { id: check, type: 'agent', label: 'Reviewer', config: agent(review, 'Review both research results: where they agree, where they differ and what is missing.') },
        { id: gate, type: 'approval', label: 'Your approval', config: { prompt: 'Read the review. Approve to save the report, or reject to stop the run.' } },
        { id: out, type: 'output', label: 'Report', config: { name: 'report', include: [ra, rb, check] } }];
      const edges = [[ra, join, 'text'], [rb, join, 'text'], [join, check, 'done'], [check, gate, 'text'], [join, gate, 'done'], [gate, out, 'done']].map(([from, to, fromPort]) => ({ id: newId('e', taken), from, to, fromPort, toPort: 'input' }));
      const at = layered(nodes.map(node => node.id), edges.map(edge => [edge.from, edge.to]));
      return { nodes: nodes.map(node => ({ ...node, position: at.get(node.id) })), edges };
    }
    function renameDialog(item) {
      const name = textInput('network-pipeline-name-input', item.name), description = Object.assign(el('textarea'), { rows: 3, maxLength: 2000, value: item.description || '' }); description.id = 'network-pipeline-description-input';
      formDialog('Rename pipeline', 'Published versions keep the name they were published with.', [labelled('Name', name), labelled('Description (optional)', description)], 'Save', async () => {
        const { pipeline } = await request(`/api/network/pipelines/${item.id}`, { method: 'PATCH', body: { expectedRevision: item.revision, name: name.value.trim(), description: description.value.trim() } });
        host.closeDialog(); say(`Saved “${pipeline.name}”.`); lst.focus = item.id; await loadList();
      });
    }
    function duplicateDialog(item) {
      const name = textInput('network-pipeline-name-input', `${clip(item.name, 73)} (copy)`);
      formDialog('Duplicate pipeline', 'The copy is a new, unpublished draft with the same steps, arrows, settings and pinned network version. Runs and versions stay with the original.', [labelled('Name', name)], 'Duplicate', async () => {
        const { pipeline } = await request(`/api/network/pipelines/${item.id}`);
        const { pipeline: copy } = await request('/api/network/pipelines', { method: 'POST', body: { networkId: pipeline.networkId, networkVersion: pipeline.networkVersion, name: name.value.trim(), description: pipeline.description, settings: pipeline.settings, nodes: pipeline.nodes, edges: pipeline.edges } });
        host.closeDialog(); say(`Created “${copy.name}”, an unpublished copy. Nothing runs.`); lst.focus = copy.id; await loadList();
      });
    }
    function deleteDialog(item) {
      ask('Delete pipeline?', [note(`“${item.name}” was never published, so no run or other pipeline can name it. Its draft is set aside in the data folder, not erased.`, 'note network-quote')], 'Delete', async () => {
        await request(`/api/network/pipelines/${item.id}`, { method: 'DELETE', body: { expectedRevision: item.revision } });
        host.closeDialog(); say(`Deleted “${item.name}”.`); lst.focus = 'none'; await loadList();
      }, { danger: true });
    }

    // ---- Designer: one draft as a working copy (steps, arrows, settings), saved as one PATCH with the loaded revision.
    const dHeading = el('h2', '', ''); dHeading.id = 'network-pipeline-heading'; dHeading.tabIndex = -1;
    const dMeta = el('div', 'network-chips network-graph-meta'); dMeta.id = 'network-pipeline-meta';
    const dAll = button('All pipelines', () => go('#/network/pipelines'), 'text-button network-pipeline-all'); dAll.id = 'network-pipeline-all';
    const dTitle = el('div', 'network-graph-title'); dTitle.append(dAll, dHeading, dMeta);
    const dSave = button('Save draft', () => void save(), 'secondary-button network-primary'); dSave.id = 'network-pipeline-save';
    const dValidate = button('Validate', () => void validate(), 'secondary-button'); dValidate.id = 'network-pipeline-validate';
    const dPublish = button('Publish', () => void publishFlow(), 'secondary-button'); dPublish.id = 'network-pipeline-publish';
    const dRun = button('Run…', () => void runDialog(null), 'secondary-button'); dRun.id = 'network-pipeline-run';
    const dUndo = button('Undo', () => undo(), 'secondary-button'); dUndo.id = 'network-pipeline-undo';
    const dDiscard = button('Discard changes…', () => discardDialog(), 'secondary-button'); dDiscard.id = 'network-pipeline-discard';
    const dActions = el('div', 'detail-actions network-graph-actions'); dActions.append(dSave, dValidate, dPublish, dRun, dUndo, dDiscard);
    const dHead = el('header', 'network-graph-head'); dHead.append(dTitle, dActions);
    const dLoad = el('div', 'network-graph-notice'); dLoad.id = 'network-pipeline-notice'; dLoad.setAttribute('role', 'status');
    // Palette (add a step), then connect and remove, then the canvas view.
    const dPalette = el('div', 'network-graph-tools network-pipeline-palette'); dPalette.setAttribute('role', 'group'); dPalette.setAttribute('aria-label', 'Add a step');
    dPalette.append(el('span', 'network-pipeline-palette-label', 'Add'));
    for (const [type, label] of TYPES) { const add = button(`${MARKS[type]} ${label}${['agent', 'subnetwork'].includes(type) ? '…' : ''}`, () => void addStep(type), `secondary-button network-step-button step-${type}`); add.id = `network-pipeline-add-${type}`; add.setAttribute('aria-label', `Add ${label.toLowerCase()} step`); add.title = HELP[type]; dPalette.append(add); }
    const dConnect = button('Connect', () => toggleConnect(), 'secondary-button'); dConnect.id = 'network-pipeline-connect'; dConnect.setAttribute('aria-pressed', 'false');
    const dPort = el('select'); dPort.id = 'network-pipeline-port';
    const dPortLabel = labelled('From port', dPort, 'field-label network-inline-label');
    const dRemove = button('Remove', () => removeSelected(), 'secondary-button'); dRemove.id = 'network-pipeline-remove';
    const dFit = button('Fit', () => fitView(dCy), 'secondary-button'); dFit.id = 'network-pipeline-fit';
    const dZoomOut = button('−', () => zoomBy(dCy, 1 / 1.25), 'secondary-button'); dZoomOut.id = 'network-pipeline-zoom-out'; dZoomOut.setAttribute('aria-label', 'Zoom out');
    const dZoomIn = button('+', () => zoomBy(dCy, 1.25), 'secondary-button'); dZoomIn.id = 'network-pipeline-zoom-in'; dZoomIn.setAttribute('aria-label', 'Zoom in');
    const dArrange = button('Arrange in order', () => arrange(), 'secondary-button'); dArrange.id = 'network-pipeline-arrange';
    const dEditTools = el('div', 'network-graph-tools'); dEditTools.append(dConnect, dPortLabel, dRemove);
    const dViewTools = el('div', 'network-graph-tools network-canvas-tools'); dViewTools.append(dFit, dZoomOut, dZoomIn, dArrange);
    const dTools = el('div', 'network-graph-toolbar'); dTools.append(dPalette, dEditTools, dViewTools);
    const dCanvas = el('div', 'network-canvas network-pipeline-canvas'); dCanvas.id = 'network-pipeline-canvas'; dCanvas.tabIndex = 0;
    dCanvas.setAttribute('role', 'application'); dCanvas.setAttribute('aria-roledescription', 'pipeline canvas'); dCanvas.setAttribute('aria-describedby', 'network-pipeline-canvas-hint');
    const dHint = note('Shapes are step types; solid arrows are execution order, labelled with the port they leave on. Drag steps to place them. With the canvas focused, arrow keys move the chosen step, Delete removes it and Escape stops connecting. The lists beside the canvas do everything with the keyboard.', 'note network-canvas-hint'); dHint.id = 'network-pipeline-canvas-hint';
    const dCanvasBox = el('div', 'network-canvas-box'); dCanvasBox.append(dCanvas, dHint);
    // The side column: an alert (kept here so no message ever moves the canvas), the details, then the lists.
    const dAlert = el('div', 'inline-error network-alert'); dAlert.id = 'network-pipeline-alert'; dAlert.setAttribute('role', 'alert'); dAlert.hidden = true;
    const dDetails = el('section', 'network-graph-details'); dDetails.id = 'network-pipeline-details'; dDetails.setAttribute('aria-label', 'Step details');
    const dStepsTitle = el('h3', '', 'Steps'); dStepsTitle.id = 'network-pipeline-steps-title';
    const dSteps = el('ul', 'network-graph-list'); dSteps.id = 'network-pipeline-steps'; dSteps.setAttribute('aria-labelledby', dStepsTitle.id);
    const dStepsMore = button('Show all steps', () => { ed.limit = Infinity; renderLists(); }, 'secondary-button network-more'); dStepsMore.id = 'network-pipeline-steps-more';
    const dEdgesTitle = el('h3', '', 'Arrows'); dEdgesTitle.id = 'network-pipeline-edges-title';
    const dEdges = el('ul', 'network-graph-list'); dEdges.id = 'network-pipeline-edges'; dEdges.setAttribute('aria-labelledby', dEdgesTitle.id);
    const dSettingsOpen = button('Pipeline settings', () => selectItem(SETTINGS, { focus: true }), 'secondary-button network-pipeline-settings-open'); dSettingsOpen.id = 'network-pipeline-open-settings';
    const dCheck = el('div', 'network-graph-issues'); dCheck.id = 'network-pipeline-check';
    const dVersions = el('div', 'network-pipeline-versions'); dVersions.id = 'network-pipeline-versions';
    const dLists = el('div', 'network-graph-lists'); dLists.append(dSettingsOpen, dStepsTitle, dSteps, dStepsMore, dEdgesTitle, dEdges, el('h3', '', 'Check'), dCheck, el('h3', '', 'Versions and runs'), dVersions);
    const dSide = el('aside', 'network-graph-side'); dSide.setAttribute('aria-label', 'Steps, arrows and details'); dSide.append(dAlert, dDetails, dLists);
    const dBody = el('div', 'network-graph-body'); dBody.append(dCanvasBox, dSide);
    designer.append(dHead, dLoad, dTools, dBody);
    window.addEventListener('beforeunload', event => { if (ed?.dirty) { event.preventDefault(); event.returnValue = ''; } });

    let ed = null, dCy = null, dragStart = null;
    const fresh = id => ({ key: id, id, loading: true, loadError: null, draft: null, name: '', description: '', networkVersion: 0, settings: null, nodes: [], edges: [], dirty: false, saving: false, undo: [],
      selected: null, phoneDetail: false, error: null, problems: new Set(), badEdges: new Set(), validation: null, rules: new Map(), connect: null, limit: LIST_PAGE, inside: null,
      network: null, members: null, agents: new Map(), agentsComplete: false, pipes: new Map(), runs: [], issues: [] });
    const byId = id => ed.nodes.find(node => node.id === id);
    const snapshot = () => clone({ name: ed.name, description: ed.description, networkVersion: ed.networkVersion, settings: ed.settings, nodes: ed.nodes, edges: ed.edges });
    const saved = () => JSON.stringify({ name: ed.draft.name, description: ed.draft.description, networkVersion: ed.draft.networkVersion, settings: ed.draft.settings, nodes: ed.draft.nodes, edges: ed.draft.edges });
    function adopt(pipeline) {
      Object.assign(ed, { draft: pipeline, ...clone({ name: pipeline.name, description: pipeline.description, networkVersion: pipeline.networkVersion, settings: pipeline.settings, nodes: pipeline.nodes, edges: pipeline.edges }), rules: new Map() });
      if (ed.selected && ed.selected !== SETTINGS && !byId(ed.selected) && !ed.edges.some(edge => edge.id === ed.selected)) ed.selected = null;
    }
    async function openDesigner(id) {
      if (ed?.key === id) return;
      ed = fresh(id); destroyCanvas('d');
      renderDesigner();
      try {
        const { pipeline } = await request(`/api/network/pipelines/${id}`);
        if (ed?.key !== id) return;
        adopt(pipeline);
        await loadContext();
      } catch (failure) { if (ed?.key === id) ed.loadError = failure; }
      if (ed?.key !== id) return;
      ed.loading = false;
      renderDesigner();
      if (!ed.loadError) dHeading.focus();
    }
    /** The network, its pinned version's members, the registrations (state and tools), sub-pipeline names and the runs. */
    async function loadContext() {
      const key = ed.key;
      const [network, agents, runs] = await Promise.all([request(`/api/network/networks/${ed.draft.networkId}`), request('/api/network/agents?limit=200'), request(`/api/network/pipeline-runs?pipelineId=${ed.id}&limit=20`)]);
      if (ed?.key !== key) return;
      Object.assign(ed, { network: network.network, agents: new Map(agents.agents.map(agent => [agent.id, agent])), agentsComplete: agents.next === null, runs: runs.runs });
      await loadMembers();
      await Promise.all([...new Set(ed.nodes.filter(node => node.type === 'subnetwork' && node.config.pipelineId).map(node => node.config.pipelineId))].map(pipeName));
    }
    async function loadMembers() {
      const key = ed.key, number = ed.networkVersion;
      try { const members = await membersOf(ed.draft.networkId, number); if (ed?.key === key && ed.networkVersion === number) ed.members = members; }
      catch (failure) { if (ed?.key === key) ed.members = { error: failure.message, agents: [], subs: [] }; }
    }
    /** A sub-pipeline's draft (its name and versions), read once per visit. */
    function pipeName(id) {
      if (!ed.pipes.has(id)) ed.pipes.set(id, null);
      return request(`/api/network/pipelines/${id}`).then(data => { ed?.pipes.set(id, data.pipeline); }, () => { ed?.pipes.set(id, { missing: true }); });
    }
    const agentName = id => { const view = ed.agents.get(id); return view ? view.displayName || view.base.name || id : ed.members?.refs?.agents?.[id]?.name || id || 'No agent chosen'; };
    function stepName(node) {
      if (!node) return 'a step that is gone';
      if (node.label) return node.label;
      if (node.type === 'agent') return agentName(node.config.agentId);
      if (node.type === 'subnetwork') { const pipe = ed.pipes.get(node.config.pipelineId); return pipe?.name || 'Sub-pipeline'; }
      if (node.type === 'output') return `Output “${node.config.name || 'report'}”`;
      return TYPE_NAMES[node.type];
    }
    function subtitle(node) {
      if (node.type === 'agent') { const view = ed.agents.get(node.config.agentId); return [`Agent · ${agentName(node.config.agentId)}`, view?.base.provider && { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', agy: 'Antigravity' }[view.base.provider], node.config.tools === 'web' ? 'web search' : ''].filter(Boolean).join(' · '); }
      if (node.type === 'subnetwork') return node.config.pipelineId ? `Sub-network pipeline · version ${node.config.version}` : 'Sub-network pipeline · not chosen';
      if (node.type === 'condition') { const rules = node.config.all || node.config.any || []; return `Condition · ${plural(rules.length, 'rule')} · ${node.config.any ? 'any' : 'all'}`; }
      if (node.type === 'join') return `Join · waits for ${node.config.require === 'any' ? 'the first' : 'all'}`;
      if (node.type === 'output') return `Output · ${node.config.name || 'report'}.md · ${plural((node.config.include || []).length, 'step')}`;
      return TYPE_NAMES[node.type];
    }
    /**
     * What to fix, per step: `blocking` ones a save would refuse (an incomplete config), the others what Validate would
     * refuse (agents that cannot take work, rules or report steps whose results do not reach them). Recomputed per render.
     */
    function computeIssues() {
      const list = [], add = (nodeId, message, blocking = false) => list.push({ nodeId, message, blocking }), reach = reaching(ed.nodes, ed.edges), present = new Set(ed.nodes.map(node => node.id));
      const memberIds = new Set((ed.members?.agents || []).map(agent => agent.id)), outputs = new Map();
      for (const node of ed.nodes) {
        const config = node.config;
        if (node.type === 'agent') {
          const view = ed.agents.get(config.agentId);
          if (!config.agentId) add(node.id, 'Choose an agent for this step.', true);
          else if (!view && ed.agentsComplete) add(node.id, 'This agent is no longer registered in Network. Choose another agent.');
          else if (view?.base.stale) add(node.id, `“${agentName(config.agentId)}” cannot be used: its Base agent is ${view.base.staleReason === 'disabled' ? 'switched off' : view.base.staleReason || 'stale'}. Fix it in Base, or choose another agent.`);
          else if (view && !view.enabled) add(node.id, `“${agentName(config.agentId)}” is switched off in Network. Switch it on in its profile, or choose another agent.`);
          if (config.agentId && ed.members && !ed.members.error && !memberIds.has(config.agentId)) add(node.id, `“${agentName(config.agentId)}” is not in version ${ed.networkVersion} of “${ed.network?.name}”. Choose a member, or add it in Graph and pin the new version.`);
          if (config.tools === 'web' && view?.providerCapabilities?.jobTools && !view.providerCapabilities.jobTools.includes('web')) add(node.id, 'Its provider cannot use web search in a Network job. Choose No tools.');
        }
        if (node.type === 'subnetwork') {
          if (!config.pipelineId) add(node.id, 'Choose a published pipeline of a contained network.', true);
          else if (ed.pipes.get(config.pipelineId)?.missing) add(node.id, 'The pinned sub-pipeline cannot be found. Choose another one.');
        }
        if (node.type === 'condition') {
          const drafts = ed.rules.get(node.id), rules = config.all || config.any || [];
          if (drafts?.some(draft => ruleOf(draft).error)) add(node.id, 'A rule is not complete. Fix it in the rule editor.', true);
          else if (!rules.length) add(node.id, 'Add at least one rule.', true);
          for (const rule of rules) {
            const step = RULE_PATH.exec(rule.path)?.[1];
            if (!present.has(step)) add(node.id, 'A rule reads a step that is no longer here.', true);
            else if (!reach.get(node.id).some(ref => ref.node === step && ref.port === 'json')) add(node.id, `A rule reads the json result of “${stepName(byId(step))}”, but no json arrow from it reaches this condition. Connect its json port on the way.`);
          }
        }
        if (node.type === 'output') {
          if (!config.include?.length) add(node.id, 'Tick at least one step for the report.', true);
          for (const id of config.include || []) {
            if (!present.has(id)) add(node.id, 'The report names a step that is no longer here.', true);
            else if (!reach.get(node.id).some(ref => ref.node === id)) add(node.id, `“${stepName(byId(id))}” is in the report, but its result does not reach this output. Connect it on the way, or untick it.`);
          }
          outputs.set(config.name, [...(outputs.get(config.name) || []), node.id]);
        }
      }
      for (const [name, ids] of outputs) if (ids.length > 1) for (const id of ids) add(id, `Two output steps save “${name}”. Give each output its own name.`);
      if (!ed.nodes.some(node => node.type === 'output')) add(null, 'Add an output step: a pipeline ends in at least one output that saves its report.');
      return list;
    }
    /** One edit of the working copy: undo keeps the copy before it; validation marks are cleared; canvas and lists follow. */
    function change(mutate, message, before = snapshot()) {
      if (!ed || ed.loading || ed.loadError) return;
      ed.undo.push(before); if (ed.undo.length > UNDO_DEPTH) ed.undo.shift();
      mutate();
      Object.assign(ed, { dirty: saved() !== JSON.stringify(snapshot()), error: null, problems: new Set(), badEdges: new Set(), validation: null });
      syncDesigner(); renderEditor();
      if (message) say(message);
    }
    function undo() {
      const last = ed?.undo.pop(); if (!last) return;
      Object.assign(ed, last, { rules: new Map() });
      if (ed.selected && ed.selected !== SETTINGS && !byId(ed.selected) && !ed.edges.some(edge => edge.id === ed.selected)) ed.selected = null;
      ed.dirty = saved() !== JSON.stringify(snapshot());
      if (ed.networkVersion !== ed.members?.version?.version) void loadMembers().then(() => renderEditor());
      syncDesigner(); renderEditor(); say('Undone.');
    }
    const taken = () => new Set([...ed.nodes, ...ed.edges].map(item => item.id));
    /** A free spot for a new step: the middle of what the canvas shows, or after the last column without a canvas. */
    function placeNew() {
      let at;
      if (dCy) { const box = dCy.extent(); at = { x: Math.round((box.x1 + box.x2) / 2), y: Math.round((box.y1 + box.y2) / 2) }; }
      else at = { x: ed.nodes.length ? Math.max(...ed.nodes.map(node => node.position.x)) + 240 : 0, y: 0 };
      for (let tries = 0; tries < 200 && ed.nodes.some(node => Math.abs(node.position.x - at.x) < 210 && Math.abs(node.position.y - at.y) < 100); tries++) at = { x: at.x + 30, y: at.y + 90 };
      return at;
    }
    const DEFAULTS = { parallel: () => ({}), join: () => ({ require: 'all' }), condition: () => ({ all: [] }), approval: () => ({ prompt: 'Check the results so far. Approve to go on, or reject to stop the run.' }), output: () => ({ name: 'report', include: [] }) };
    async function addStep(type, config = null) {
      if (!ed || ed.loading) return;
      if (type === 'agent' && !config) { agentDialog(); return; }
      if (type === 'subnetwork' && !config) { await subnetworkDialog(); return; }
      const id = newId('n', taken()), node = { id, type, label: '', position: placeNew(), config: config || DEFAULTS[type]() };
      if (type === 'output') node.config.name = ['report', ...Array.from({ length: 50 }, (_, n) => `report-${n + 2}`)].find(name => !ed.nodes.some(item => item.type === 'output' && item.config.name === name));
      change(() => { ed.nodes.push(node); }, `Added ${TYPE_NAMES[type].toLowerCase()} step “${stepName(node)}”. ${type === 'condition' ? 'Add its rules in the details.' : type === 'output' ? 'Connect steps to it and tick what the report holds.' : 'Connect it with arrows.'} Save the draft to keep it.`);
      selectItem(id, { focus: true });
    }
    function agentDialog() {
      const members = ed.members?.agents || [];
      if (!members.length) { host.openDialog('Add agent step', [note(ed.members?.error ? `Could not read the pinned network version. ${ed.members.error}` : `Version ${ed.networkVersion} of “${ed.network?.name}” has no agents. Add agents to the network in Graph, publish it, and pin the new version in Pipeline settings.`), closeActions()]); return; }
      const list = el('ul', 'network-pick-list'); list.id = 'network-pipeline-pick-agents'; list.setAttribute('aria-label', 'Agents of the pinned network version');
      for (const member of members) {
        const view = ed.agents.get(member.id), state = !view ? (ed.agentsComplete ? 'Not registered' : '') : view.base.stale ? 'Stale' : view.enabled ? '' : 'Switched off';
        const pick = button('', () => { host.closeDialog(); void addStep('agent', { agentId: member.id, instructions: '', tools: 'none', timeoutMs: null, retries: 0 }); }, 'network-agent network-pick'); pick.dataset.agentId = member.id;
        const text = el('span', 'network-row-text'); text.append(el('strong', '', agentName(member.id)), el('span', 'network-row-sub', subtitleOfAgent(view)));
        if (state) text.append(chip(state, 'warn'));
        pick.append(text); const item = el('li'); item.append(pick); list.append(item);
      }
      host.openDialog('Add agent step', [note(`Members of version ${ed.networkVersion} of “${ed.network?.name}”. One agent may run in several steps; each step is its own job.`), list, closeActions()]);
      list.querySelector('button')?.focus();
    }
    const subtitleOfAgent = view => (view ? [{ profile: 'Agent', agentProfile: 'Agent profile' }[view.base.kind] || 'Agent', { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', agy: 'Antigravity' }[view.base.provider]].filter(Boolean).join(' · ') : 'Registration not loaded');
    /** Published pipelines of the networks this network version contains, at the version it pins (architecture §14 item 13). */
    async function subOptions() {
      const options = [];
      for (const sub of ed.members?.subs || []) {
        const data = await request(`/api/network/pipelines?networkId=${sub.networkId}&limit=200`);
        for (const item of data.pipelines) for (const entry of item.publishedVersions) if (entry.networkVersion === sub.version) options.push({ pipelineId: item.id, version: entry.version, label: `${item.name} · version ${entry.version} (network “${sub.name}” version ${sub.version})`, name: item.name });
      }
      return options;
    }
    async function subnetworkDialog(node = null) {
      host.openDialog(node ? 'Choose the sub-pipeline' : 'Add sub-network step', [note('Loading the pipelines of contained networks…')]);
      let options;
      try { options = await subOptions(); } catch (failure) { host.openDialog('Add sub-network step', [el('p', 'inline-error', failure.message), closeActions()]); return; }
      if (!ed) return;
      if (!options.length) {
        host.openDialog('Add sub-network step', [note(`A sub-network step runs a published pipeline of a network that version ${ed.networkVersion} of “${ed.network?.name}” contains, pinned at the same network version. ${(ed.members?.subs || []).length ? 'None of its sub-networks has such a pipeline yet: build and publish one there first.' : 'This version contains no sub-network: add one in Graph and publish first.'}`), closeActions()]);
        return;
      }
      const pick = select(options.map(option => [`${option.pipelineId}@${option.version}`, option.label])); pick.id = 'network-pipeline-pick-sub';
      if (node?.config.pipelineId) pick.value = `${node.config.pipelineId}@${node.config.version}`;
      formDialog(node ? 'Choose the sub-pipeline' : 'Add sub-network step', 'The step pins this published version: it is expanded when a run starts, and later versions never change it. It passes on its report text.', [labelled('Published pipeline', pick)], node ? 'Use it' : 'Add step', async () => {
        const option = options.find(item => `${item.pipelineId}@${item.version}` === pick.value);
        ed.pipes.set(option.pipelineId, { id: option.pipelineId, name: option.name, publishedVersions: [] });
        host.closeDialog();
        if (node) change(() => { node.config = { pipelineId: option.pipelineId, version: option.version }; }, `“${stepName(node)}” now runs ${option.label}.`);
        else await addStep('subnetwork', { pipelineId: option.pipelineId, version: option.version });
        void pipeName(option.pipelineId).then(() => renderEditor());
      }, 'network-pipeline-pick-sub-add');
    }
    function removeStep(id) {
      const node = byId(id); if (!node) return;
      const arrows = ed.edges.filter(edge => edge.from === id || edge.to === id).length;
      change(() => {
        ed.nodes = ed.nodes.filter(item => item.id !== id); ed.edges = ed.edges.filter(edge => edge.from !== id && edge.to !== id);
        for (const other of ed.nodes) {
          if (other.type === 'output') other.config.include = other.config.include.filter(item => item !== id);
          if (other.type === 'condition') { const mode = other.config.any ? 'any' : 'all'; other.config[mode] = other.config[mode].filter(rule => RULE_PATH.exec(rule.path)?.[1] !== id); ed.rules.delete(other.id); }
        }
        if (ed.selected === id) ed.selected = null; ed.phoneDetail = false;
      }, `Removed “${stepName(node)}”${arrows ? ` and ${plural(arrows, 'arrow')}` : ''}. Undo brings it back.`);
    }
    /** An execution arrow leaving `from` on `port` and arriving on `to`'s input: ports per type, no loop, each once. */
    function addEdge(from, port, to) {
      const a = byId(from), b = byId(to);
      if (!a || !b) { say('Choose two steps of this pipeline.'); return false; }
      if (from === to) { say('An arrow joins two different steps.'); return false; }
      if (!PORTS[a.type].length) { say('An output step ends its pipeline: no arrow leaves it.'); return false; }
      if (!PORTS[a.type].includes(port)) port = PORTS[a.type][0];
      if (ed.edges.some(edge => edge.from === from && edge.to === to && edge.fromPort === port)) { say('This arrow already exists.'); return false; }
      if (loops(ed.edges, from, to)) { say(`An arrow from “${stepName(a)}” to “${stepName(b)}” would make a loop. A pipeline runs each step once: a step may retry instead.`); return false; }
      const include = b.type === 'output' && ['agent', 'subnetwork', 'output'].includes(a.type) && !b.config.include.includes(from) && b.config.include.length < 50;
      change(() => { ed.edges.push({ id: newId('e', taken()), from, to, fromPort: port, toPort: 'input' }); if (include) b.config.include.push(from); },
        `“${stepName(b)}” now runs after “${stepName(a)}” (${PORT_NAMES[port]}).${include ? ` Its result is in the report “${b.config.name}”.` : ''} Nothing runs.`);
      return true;
    }
    function removeEdge(id) {
      const edge = ed.edges.find(item => item.id === id); if (!edge) return;
      change(() => { ed.edges = ed.edges.filter(item => item.id !== id); if (ed.selected === id) ed.selected = null; }, `Removed the arrow from “${stepName(byId(edge.from))}” to “${stepName(byId(edge.to))}”.`);
    }
    function removeSelected() { if (!ed?.selected || ed.selected === SETTINGS) { say('Choose a step or an arrow first.'); return; } if (byId(ed.selected)) removeStep(ed.selected); else removeEdge(ed.selected); }
    function arrange() {
      if (!ed?.nodes.length) return;
      const at = layered(ed.nodes.map(node => node.id), ed.edges.map(edge => [edge.from, edge.to]));
      change(() => { for (const node of ed.nodes) node.position = at.get(node.id); }, 'Arranged in execution order, left to right. Save the draft to keep the positions.');
      fitView(dCy);
    }
    function selectItem(id, { focus = false } = {}) {
      if (!ed) return;
      ed.selected = id; ed.inside = null;
      if (id && isPhone()) ed.phoneDetail = true;
      if (dCy) dCy.batch(() => { dCy.elements(':selected').unselect(); if (id && id !== SETTINGS) dCy.getElementById(id).select(); });
      renderEditor();
      if (focus) document.querySelector('#network-pipeline-detail-heading')?.focus();
    }

    // ---- Save, validate, publish, run. Every save names the revision it was loaded at; nothing is ever overwritten.
    async function save() {
      if (!ed || ed.saving || ed.loading) return false;
      const blockers = ed.issues.filter(issue => issue.blocking);
      if (blockers.length) {
        Object.assign(ed, { error: { message: `Not saved. Finish ${plural(new Set(blockers.map(issue => issue.nodeId)).size, 'step')} first: ${blockers.map(issue => `${stepName(byId(issue.nodeId))}: ${issue.message}`).join(' ')}` }, problems: new Set(blockers.map(issue => issue.nodeId)) });
        syncDesigner(); renderEditor(); say('Not saved: some steps are not complete. They are marked.');
        return false;
      }
      ed.saving = true; renderHead();
      try {
        const { pipeline } = await request(`/api/network/pipelines/${ed.id}`, { method: 'PATCH', body: { expectedRevision: ed.draft.revision, name: ed.name, description: ed.description, networkVersion: ed.networkVersion, settings: ed.settings, nodes: ed.nodes, edges: ed.edges } });
        adopt(pipeline);
        Object.assign(ed, { dirty: false, undo: [], error: null, problems: new Set(), badEdges: new Set() });
        say(`Saved the draft of “${pipeline.name}” (revision ${pipeline.revision}). Nothing started.`);
        return true;
      } catch (failure) {
        const marks = marksOf(failure, ed.nodes);
        Object.assign(ed, { error: failure, problems: marks.nodes, badEdges: marks.edges });
        say(`Not saved. ${failure.message}`);
        return false;
      } finally { if (ed) { ed.saving = false; syncDesigner(); renderEditor(); } }
    }
    /** Compile the saved draft as a run would, without running it (saving first when there are changes). */
    async function validate() {
      if (!ed || ed.loading) return null;
      if (ed.dirty && !(await save())) return null;
      const key = ed.key, revision = ed.draft.revision;
      dValidate.disabled = true;
      let result;
      try { result = await request(`/api/network/pipelines/${ed.id}/validate`, { method: 'POST', body: {} }); }
      catch (failure) { if (ed?.key === key) { ed.error = failure; renderEditor(); } return null; }
      finally { dValidate.disabled = false; }
      if (ed?.key !== key) return null;
      const marks = result.valid ? { nodes: new Set(), edges: new Set() } : marksOf(result.error, ed.nodes);
      Object.assign(ed, { validation: { ...result, revision }, problems: marks.nodes, badEdges: marks.edges, error: null });
      syncDesigner(); renderEditor();
      say(result.valid ? `Valid as saved (revision ${revision}): ${plural(result.summary.steps, 'step')}, ${plural(result.summary.agentSteps, 'agent job')}. Nothing ran.` : `Not valid: ${result.error.message}`);
      return result;
    }
    async function publishFlow() {
      const checked = await validate();
      if (!checked?.valid) return;
      const next = (ed.draft.publishedVersions.at(-1)?.version || 0) + 1, previous = ed.draft.publishedVersions.at(-1);
      let diff = 'This is the first version.';
      if (previous) { try { diff = diffOf(await pipelineVersion(ed.id, previous.version), { ...ed.draft, number: next }); } catch (failure) { diff = `The previous version could not be read to compare (${failure.message}).`; } }
      const summary = note(`${plural(checked.summary.steps, 'step')} after sub-pipelines are expanded, ${plural(checked.summary.agentSteps, 'agent job')}, ${plural(checked.summary.groups, 'sub-pipeline')}. It pins version ${ed.draft.networkVersion} of “${ed.network?.name}”.`);
      const diffNote = note(diff, 'note network-pipeline-diff'); diffNote.id = 'network-pipeline-diff';
      ask(`Publish version ${next}?`, [note(`Version ${next} of “${ed.draft.name}” is saved exactly as the draft is now (revision ${ed.draft.revision}). A published version never changes and is never deleted; a run pins its number, never the draft.`), summary, diffNote, note('Publishing starts nothing.')], `Publish version ${next}`, async () => {
        let data;
        try { data = await request(`/api/network/pipelines/${ed.id}/publish`, { method: 'POST', body: { expectedRevision: ed.draft.revision } }); }
        catch (failure) {
          if (failure.code !== 'REVISION_CONFLICT' && !failure.details) throw failure;
          host.closeDialog(); const marks = marksOf(failure, ed.nodes); Object.assign(ed, { error: failure, problems: marks.nodes, badEdges: marks.edges }); syncDesigner(); renderEditor(); return;
        }
        adopt(data.pipeline); Object.assign(ed, { dirty: false, undo: [] });
        host.closeDialog(); say(`Published version ${data.published.version} of “${data.pipeline.name}”. It never changes. Nothing started.`);
        syncDesigner(); renderEditor(); document.querySelector('#network-pipeline-run')?.focus();
      });
    }
    async function reloadTheirs() { const id = ed.id; ed = null; destroyCanvas('d'); await openDesigner(id); say('Loaded the saved pipeline. Your unsaved changes were dropped.'); }
    async function saveAsNew() {
      const base = clip(ed.name, 60);
      for (let n = 1; n <= 9; n++) {
        try {
          const { pipeline } = await request('/api/network/pipelines', { method: 'POST', body: { networkId: ed.draft.networkId, networkVersion: ed.networkVersion, name: `${base} (my changes${n > 1 ? ` ${n}` : ''})`, description: ed.description, settings: ed.settings, nodes: ed.nodes, edges: ed.edges } });
          ed.dirty = false; say(`Saved your changes as “${pipeline.name}”. The other draft is unchanged.`); go(`#/network/pipelines/${pipeline.id}`); return;
        } catch (failure) { if (failure.code !== 'PIPELINE_NAME_TAKEN') { ed.error = failure; renderEditor(); return; } }
      }
    }
    function discardDialog() {
      ask('Discard unsaved changes?', [note(`The draft goes back to revision ${ed.draft.revision} as it is saved. This cannot be undone.`)], 'Discard changes', async () => {
        adopt(ed.draft); Object.assign(ed, { dirty: false, undo: [], error: null, problems: new Set(), badEdges: new Set(), selected: null });
        if (ed.networkVersion !== ed.members?.version?.version) await loadMembers();
        host.closeDialog(); syncDesigner(); renderEditor(); say('Discarded the unsaved changes.');
      }, { danger: true });
    }
    /**
     * Run an explicit published version after a confirmation that shows what will run: the version, its steps and agent
     * jobs, how many at once, the permissions and tools, and that cost is not enforced. Nothing claims more than that.
     */
    async function runDialog(number) {
      if (!ed?.draft?.publishedVersions.length) return;
      const versions = [...ed.draft.publishedVersions].reverse(), pick = select(versions.map(entry => [String(entry.version), `Version ${entry.version}${entry === versions[0] ? ' (latest)' : ''} · published ${ago(entry.publishedAt)}`])); pick.id = 'network-run-version';
      pick.value = String(number || versions[0].version);
      const facts = el('div', 'network-run-facts'); facts.id = 'network-run-facts'; facts.setAttribute('aria-live', 'polite');
      const input = Object.assign(el('textarea'), { rows: 4, maxLength: 262144, placeholder: 'What the steps work on, for example a topic or a question.' }); input.id = 'network-run-input';
      const { submit, failure } = formDialog('Run pipeline', 'A run starts the steps of one published version as Network jobs, in the order its arrows give. Your draft is not run.', [labelled('Version', pick), facts, labelled('Run input (optional)', input)], 'Start run', async () => {
        const data = await request(`/api/network/pipelines/${ed.id}/runs`, { method: 'POST', body: { version: Number(pick.value), confirm: true, ...(input.value.trim() ? { input: { text: input.value } } : {}) } });
        host.closeDialog();
        if (ed.dirty) {
          say(`Started a run of version ${pick.value}. Your unsaved changes stay here; open the run from “Versions and runs”.`);
          ed.runs = (await request(`/api/network/pipeline-runs?pipelineId=${ed.id}&limit=20`)).runs; renderEditor(); return;
        }
        say(`Started a run of version ${pick.value}.`); go(`#/network/runs/${data.runId}`);
      }, 'network-run-start');
      let turn = 0;
      const fill = async () => {
        const mine = ++turn, number = Number(pick.value); submit.disabled = true; failure.hidden = true; facts.replaceChildren(note('Checking this version as a run would…'));
        try {
          const [check, settings, jobs, version] = await Promise.all([request(`/api/network/pipelines/${ed.id}/validate`, { method: 'POST', body: { version: number } }), request('/api/network/settings'), request('/api/network/jobs?limit=1'), pipelineVersion(ed.id, number)]);
          if (mine !== turn) return;
          const ceiling = settings.settings.maxConcurrentJobs, agents = version.nodes.filter(node => node.type === 'agent');
          const tools = agents.length ? agents.map(node => `${node.label || agentName(node.config.agentId)}: ${node.config.tools === 'web' ? 'read-only web search' : 'no tools'}`).join('; ') : 'No agent steps at the top level.';
          const rows = check.valid ? [
            ['Version', `${number} of “${version.name}”, pinned with its exact sub-pipeline versions. Editing or publishing the draft never changes this run.`],
            ['Steps', `${plural(check.summary.steps, 'step')} after sub-pipelines are expanded; ${plural(check.summary.agentSteps, 'agent job')}.`],
            ['At once', `At most ${Math.min(version.settings.maxParallel, ceiling)} agent ${Math.min(version.settings.maxParallel, ceiling) === 1 ? 'step' : 'steps'} at a time (this pipeline allows ${version.settings.maxParallel}; the app runs at most ${plural(ceiling, 'Network job')} at once).`],
            ['Permissions', 'Each agent step is its own Network job with its agent’s CLI sign-in: read-only, in an empty folder, no project files or lessons, only the agent’s approved memory.'],
            ['Tools', tools],
            ['Time', `Stops after ${Math.round(version.settings.deadlineMs / 60000)} minutes of running (time waiting for you does not count). If a step fails: ${version.settings.failurePolicy === 'stop' ? 'the run stops' : 'independent steps finish, then the run ends failed'}.`],
            ['Cost', COST],
          ] : [];
          const list = el('dl', 'network-facts'); for (const [label, value] of rows) list.append(el('dt', '', label), el('dd', '', value));
          facts.replaceChildren(...(check.valid ? [list] : []));
          if (!jobs.worker) facts.append(note('No job worker is available in this app: agent steps wait in the queue, and nothing runs until one is.', 'network-stale'));
          if (!check.valid) { const why = el('p', 'inline-error', `This version cannot start now: ${check.error.message}`); why.setAttribute('role', 'alert'); facts.append(why); submit.title = 'It cannot start now; see why above.'; return; }
          submit.disabled = false; submit.title = '';
        } catch (error) { if (mine === turn) facts.replaceChildren(el('p', 'inline-error', `Could not check this version. ${error.message}`)); }
      };
      pick.addEventListener('change', () => void fill());
      await fill();
    }

    // ---- Designer rendering
    function renderDesigner() {
      if (!ed || designer.hidden) return;
      renderEditor();
    }
    function renderEditor() {
      if (!ed || designer.hidden) return;
      ed.issues = ed.loading || ed.loadError ? [] : computeIssues();
      panel.dataset.view = ed.phoneDetail && ed.selected ? 'detail' : 'list';
      renderHead();
      const failed = ed.loadError ? el('div', 'inline-error network-alert') : null;
      if (failed) { failed.setAttribute('role', 'alert'); failed.append(el('span', '', ed.loadError.message), button('All pipelines', () => go('#/network/pipelines'), 'secondary-button')); }
      dLoad.replaceChildren(...(ed.loading ? [note('Loading the pipeline…', 'note network-notice')] : failed ? [failed] : !isPhone() && !window.cytoscape ? [note('The canvas could not load in this browser. The lists beside it show and edit the same pipeline.', 'note network-notice')] : []));
      const ready = !ed.loading && !ed.loadError;
      dTools.hidden = !ready; dBody.hidden = !ready;
      if (!ready) return;
      const canvasOn = Boolean(window.cytoscape) && !isPhone();
      for (const control of [dFit, dZoomOut, dZoomIn, dConnect]) control.hidden = !canvasOn;
      dArrange.hidden = isPhone(); dCanvasBox.hidden = !canvasOn;
      dPortLabel.hidden = !ed.connect;
      dConnect.setAttribute('aria-pressed', String(Boolean(ed.connect))); dConnect.textContent = ed.connect ? 'Stop connecting' : 'Connect';
      const removable = ed.selected && ed.selected !== SETTINGS && (byId(ed.selected) || ed.edges.some(edge => edge.id === ed.selected));
      dRemove.disabled = !removable; dRemove.title = removable ? '' : 'Choose a step or an arrow first.';
      dCanvas.setAttribute('aria-label', `Pipeline canvas: ${plural(ed.nodes.length, 'step')} and ${plural(ed.edges.length, 'arrow')}. The lists beside it hold the same steps and arrows.`);
      drawCanvas('d');
      renderAlert(); renderDetails(); renderLists(); renderCheck(); renderVersions();
    }
    function renderHead() {
      if (!ed) return;
      const draft = ed.draft;
      dHeading.textContent = ed.loadError ? 'Pipeline not available' : !draft ? 'Loading…' : ed.name || draft.name;
      dMeta.replaceChildren();
      if (draft && !ed.loadError) {
        dMeta.append(chip(`Draft · revision ${draft.revision}`, 'ok'), ...(ed.dirty ? [Object.assign(chip('Unsaved changes', 'warn'), { id: 'network-pipeline-dirty' })] : []),
          chip(`Network “${ed.network?.name || draft.networkId}” · version ${ed.networkVersion}`, 'off'));
        const latest = draft.publishedVersions.at(-1);
        dMeta.append(latest ? Object.assign(chip(`Version ${latest.version} latest · published ${ago(latest.publishedAt)}`, 'ok'), { id: 'network-pipeline-latest' }) : chip('Not published yet', 'off'));
      }
      const ready = Boolean(draft) && !ed.loading && !ed.loadError;
      for (const control of [dSave, dValidate, dPublish, dRun, dUndo, dDiscard]) control.hidden = !ready;
      if (!ready) return;
      const next = (draft.publishedVersions.at(-1)?.version || 0) + 1, conflict = ed.error?.code === 'REVISION_CONFLICT' ? 'This pipeline was saved elsewhere: load the saved pipeline, or save yours as a new pipeline, first.' : '';
      dSave.disabled = !ed.dirty || ed.saving || Boolean(conflict); dSave.title = conflict || (ed.dirty ? '' : 'No unsaved changes'); dSave.textContent = ed.saving ? 'Saving…' : 'Save draft';
      dValidate.textContent = ed.dirty ? 'Save and validate' : 'Validate'; dValidate.disabled = ed.saving || Boolean(conflict); dValidate.title = conflict;
      dPublish.textContent = ed.dirty ? `Save, validate and publish version ${next}` : `Validate and publish version ${next}`; dPublish.disabled = ed.saving || Boolean(conflict); dPublish.title = conflict;
      dRun.disabled = !draft.publishedVersions.length; dRun.title = dRun.disabled ? 'Publish a version first: a run always runs a published version, never the draft.' : '';
      dUndo.disabled = !ed.undo.length; dUndo.title = ed.undo.length ? '' : 'Nothing to undo';
      dDiscard.disabled = !ed.dirty; dDiscard.title = ed.dirty ? '' : 'No unsaved changes';
    }
    function renderAlert() {
      const failure = ed.error;
      dAlert.hidden = !failure; if (!failure) { dAlert.replaceChildren(); return; }
      dAlert.replaceChildren(el('span', '', failure.message));
      if (failure.code === 'REVISION_CONFLICT') {
        const theirs = button('Load the saved pipeline', () => void reloadTheirs(), 'secondary-button network-reload'); theirs.id = 'network-pipeline-reload';
        const mine = button('Save mine as a new pipeline', () => void saveAsNew(), 'secondary-button'); mine.id = 'network-pipeline-save-new';
        dAlert.append(note('Someone saved this pipeline elsewhere after you opened it. Nothing was overwritten: load the saved pipeline (your changes are dropped), or keep yours as a new pipeline.'), theirs, mine);
        return;
      }
      for (const id of ed.problems) { const show = button(`Show “${stepName(byId(id))}”`, () => selectItem(id, { focus: true }), 'secondary-button'); show.dataset.showStep = id; dAlert.append(show); }
    }
    const issueText = id => ed.issues.filter(issue => issue.nodeId === id).map(issue => issue.message);
    function stepState(node) { return ed.problems.has(node.id) ? 'problem' : ed.issues.some(issue => issue.nodeId === node.id) ? 'warn' : 'ok'; }
    function renderLists() {
      keepFocus(dLists, () => {
        const order = topo(ed.nodes.map(node => node.id), ed.edges.map(edge => [edge.from, edge.to])).map(byId);
        dStepsTitle.textContent = `Steps in execution order (${ed.nodes.length})`;
        dSteps.replaceChildren(...order.slice(0, ed.limit).map((node, index) => {
          const item = el('li', 'network-graph-row'), state = stepState(node); item.dataset.state = state === 'ok' ? 'ok' : 'stale';
          const pick = button('', () => selectItem(node.id, { focus: true }), 'network-graph-item'); pick.dataset.stepId = node.id;
          if (ed.selected === node.id) pick.setAttribute('aria-current', 'true');
          if (state === 'problem') pick.classList.add('is-problem');
          const text = el('span', 'network-row-text'); text.append(el('strong', '', `${index + 1}. ${stepName(node)}`), el('span', 'network-row-sub', subtitle(node)));
          const why = issueText(node.id);
          if (state === 'problem') text.append(chip(ed.validation?.error ? 'Refused by Validate' : 'Not saved', 'warn'));
          else if (why.length) text.append(chip(why.length === 1 ? 'Check it' : `${why.length} things to check`, 'warn'));
          const mark = el('span', `network-node-mark mark-${node.type}`, MARKS[node.type]); mark.setAttribute('aria-hidden', 'true');
          pick.append(mark, text); item.append(pick);
          return item;
        }));
        if (!ed.nodes.length) dSteps.append(el('li', 'note', 'No steps yet. Add steps from the palette, or start from the template in the list of pipelines.'));
        dStepsMore.hidden = ed.nodes.length <= ed.limit; dStepsMore.textContent = `Show all ${plural(ed.nodes.length, 'step')}`;
        dEdgesTitle.textContent = `Arrows (${ed.edges.length})`;
        dEdges.replaceChildren(...ed.edges.slice(0, ed.limit).map(edge => {
          const item = el('li', `network-graph-row port-${edge.fromPort}`), from = byId(edge.from), to = byId(edge.to);
          const pick = button('', () => selectItem(edge.id, { focus: true }), 'network-graph-item'); pick.dataset.edgeId = edge.id;
          if (ed.selected === edge.id) pick.setAttribute('aria-current', 'true');
          if (ed.badEdges.has(edge.id)) pick.classList.add('is-problem');
          const text = el('span', 'network-row-text'); text.append(el('strong', '', `${stepName(from)} → ${stepName(to)}`), el('span', `network-row-sub network-port port-${edge.fromPort}`, `${edge.fromPort} → input · ${PORT_NAMES[edge.fromPort]}`));
          pick.append(text); item.append(pick);
          const cut = button('Remove', () => removeEdge(edge.id), 'text-button'); cut.dataset.removeEdge = edge.id; cut.setAttribute('aria-label', `Remove the arrow ${stepName(from)} to ${stepName(to)}`); item.append(cut);
          return item;
        }));
        if (!ed.edges.length) dEdges.append(el('li', 'note', 'No arrows yet. Choose a step, then add an arrow to the step that runs after it.'));
      });
    }
    function renderCheck() {
      keepFocus(dCheck, () => {
        const list = el('ul', 'network-issues'); list.setAttribute('aria-label', 'Things to fix');
        const v = ed.validation;
        if (v?.valid) list.append(Object.assign(el('li', 'network-issue is-clear', `Valid as saved (revision ${v.revision}): ${plural(v.summary.steps, 'step')} after sub-pipelines are expanded, ${plural(v.summary.agentSteps, 'agent job')}, ${plural(v.summary.groups, 'sub-pipeline')}. Nothing ran.`), { id: 'network-pipeline-valid' }));
        if (v && !v.valid) {
          const item = el('li', 'network-issue issue-refused'); item.id = 'network-pipeline-invalid';
          item.append(el('strong', '', 'Validate refused it: '), el('span', '', v.error.message));
          const actions = el('span', 'network-record-actions');
          for (const id of ed.problems) { const show = button(`Show “${stepName(byId(id))}”`, () => selectItem(id, { focus: true }), 'text-button'); show.dataset.issueStep = id; actions.append(show); }
          for (const id of ed.badEdges) { const show = button('Show the arrow', () => selectItem(id, { focus: true }), 'text-button'); show.dataset.issueEdge = id; actions.append(show); }
          item.append(actions); list.append(item);
        }
        for (const issue of ed.issues) {
          const item = el('li', `network-issue${issue.blocking ? ' issue-blocking' : ''}`); item.append(el('span', '', issue.nodeId ? `${stepName(byId(issue.nodeId))}: ${issue.message}` : issue.message));
          if (issue.nodeId) { const show = button('Show', () => selectItem(issue.nodeId, { focus: true }), 'text-button'); show.dataset.issueStep = issue.nodeId; show.setAttribute('aria-label', `Show ${stepName(byId(issue.nodeId))}`); const box = el('span', 'network-record-actions'); box.append(show); item.append(box); }
          list.append(item);
        }
        if (!list.children.length) list.append(el('li', 'network-issue is-clear', 'Nothing to fix here. Validate checks it as a run would: agents, ports, sub-pipelines and the report. Nothing runs.'));
        dCheck.replaceChildren(list, ...(ed.dirty ? [note('Unsaved changes are checked by the server when you save or validate.')] : []));
      });
    }
    function renderVersions() {
      keepFocus(dVersions, () => {
        const versions = el('ul', 'network-versions'); versions.setAttribute('aria-label', 'Published versions');
        for (const entry of [...ed.draft.publishedVersions].reverse()) {
          const item = el('li'); item.dataset.version = String(entry.version);
          const text = el('span', 'network-row-text'); text.append(el('strong', '', `Version ${entry.version}`), el('span', 'network-row-sub', `Published ${ago(entry.publishedAt)} · network version ${entry.networkVersion} · sha256 ${entry.sha256.slice(0, 12)}`));
          if (entry === ed.draft.publishedVersions.at(-1)) text.append(chip('Latest', 'ok'));
          const run = button('Run…', () => void runDialog(entry.version), 'text-button'); run.dataset.runVersion = String(entry.version); run.setAttribute('aria-label', `Run version ${entry.version}`);
          item.append(text, run); versions.append(item);
        }
        const runs = el('ul', 'network-list network-pipeline-runs'); runs.id = 'network-pipeline-runs'; runs.setAttribute('aria-label', 'Runs of this pipeline');
        runs.append(...ed.runs.map(run => runRow(run, ed.name)));
        dVersions.replaceChildren(...(ed.draft.publishedVersions.length ? [versions, note('A published version never changes. Runs pin a version, never the draft.')] : [note('Not published yet. Validate and publish it; then Run starts that version.')]),
          el('h4', '', `Runs (${ed.runs.length})`), ...(ed.runs.length ? [runs] : [note('No runs yet.')]));
      });
    }
    function renderDetails() {
      keepFocus(dDetails, () => {
        const id = ed.selected, heading = text => { const title = el('h3', 'network-graph-detail-title', text); title.id = 'network-pipeline-detail-heading'; title.tabIndex = -1; return title; };
        const back = button('Back to the lists', () => { const last = ed.selected; ed.phoneDetail = false; renderEditor(); (dLists.querySelector(`[data-step-id="${last}"], [data-edge-id="${last}"]`) || dSettingsOpen).focus(); }, 'text-button network-back'); back.id = 'network-pipeline-back';
        const edge = ed.edges.find(item => item.id === id), node = byId(id);
        if (edge) { dDetails.replaceChildren(back, heading('Arrow'), ...edgeDetails(edge)); return; }
        if (node) { dDetails.replaceChildren(back, heading(stepName(node)), ...stepDetails(node)); return; }
        if (id && id !== SETTINGS) ed.selected = null;
        dDetails.replaceChildren(back, heading('Pipeline settings'), ...settingsForm());
      });
    }
    /** Run a change from a form control when it changed (`read` gives the new value, `apply` stores it). */
    function bind(control, read, apply, message) { control.addEventListener('change', () => { const value = read(); if (value !== undefined) change(() => apply(value), typeof message === 'function' ? message(value) : message); }); return control; }
    function fieldError(text) { const node = el('p', 'network-field-error', text); node.setAttribute('role', 'alert'); return node; }
    function settingsForm() {
      const name = textInput('network-pipeline-settings-name', ed.name);
      const description = Object.assign(el('textarea'), { rows: 2, maxLength: 2000, value: ed.description }); description.id = 'network-pipeline-settings-description';
      const versions = [...(ed.network?.publishedVersions || [])].reverse(), version = select(versions.map(entry => [String(entry.version), `Version ${entry.version}${entry === versions[0] ? ' (latest)' : ''}`])); version.id = 'network-pipeline-settings-network-version';
      version.value = String(ed.networkVersion);
      const parallel = select([1, 2, 3, 4].map(n => [String(n), String(n)])); parallel.id = 'network-pipeline-settings-parallel'; parallel.value = String(ed.settings.maxParallel);
      const deadline = Object.assign(el('input'), { type: 'number', min: 1, max: 1440, step: 1, value: String(Math.round(ed.settings.deadlineMs / 60000)) }); deadline.id = 'network-pipeline-settings-deadline';
      const policy = select([['stop', 'Stop the run'], ['continue_independent', 'Let independent steps finish']]); policy.id = 'network-pipeline-settings-policy'; policy.value = ed.settings.failurePolicy;
      const errors = el('div');
      bind(name, () => { const value = name.value.trim(); if (!value || /[\r\n\t]/.test(value)) { errors.replaceChildren(fieldError('A name is one line of 1 to 80 characters.')); return undefined; } errors.replaceChildren(); return value === ed.name ? undefined : value; }, value => { ed.name = value; }, 'Renamed. Save the draft to keep it.');
      bind(description, () => (description.value.trim() === ed.description ? undefined : description.value.trim()), value => { ed.description = value; });
      bind(version, () => Number(version.value), value => { ed.networkVersion = value; ed.members = null; void loadMembers().then(() => renderEditor()); }, value => `The pipeline now pins version ${value} of “${ed.network?.name}”. Its agent steps may use only that version’s agents.`);
      bind(parallel, () => Number(parallel.value), value => { ed.settings = { ...ed.settings, maxParallel: value }; }, value => `At most ${value} agent ${value === 1 ? 'step' : 'steps'} of a run at a time.`);
      bind(deadline, () => { const value = Number(deadline.value); if (!Number.isInteger(value) || value < 1 || value > 1440) { errors.replaceChildren(fieldError('The deadline is 1 to 1,440 minutes (24 hours).')); return undefined; } errors.replaceChildren(); return value * 60000; }, value => { ed.settings = { ...ed.settings, deadlineMs: value }; });
      bind(policy, () => policy.value, value => { ed.settings = { ...ed.settings, failurePolicy: value }; });
      return [note(`It belongs to the network “${ed.network?.name || ed.draft.networkId}” and pins one of its published versions. Its steps may use only that version’s agents.`),
        labelled('Name', name), labelled('Description (optional)', description), labelled('Pinned network version', version), labelled('Agent steps at once (1–4)', parallel),
        labelled('Deadline in minutes of running', deadline), labelled('If a step fails', policy), errors, note('The app’s own job limit also applies; cost and tokens are not limited.')];
    }
    function portsOf(node) {
      const reach = reaching(ed.nodes, ed.edges).get(node.id) || [], into = ed.edges.filter(edge => edge.to === node.id), out = ed.edges.filter(edge => edge.from === node.id);
      const box = el('div', 'network-pipeline-ports'); box.id = 'network-pipeline-ports';
      const incoming = el('ul', 'network-graph-list'); incoming.setAttribute('aria-label', 'Arrows into its input port');
      for (const edge of into) { const row = el('li', 'network-graph-row'); row.append(el('span', 'network-row-sub', `input ← ${stepName(byId(edge.from))} (${edge.fromPort})`)); incoming.append(row); }
      const outgoing = el('ul', 'network-graph-list'); outgoing.setAttribute('aria-label', 'Arrows from its ports');
      for (const edge of out) {
        const row = el('li', 'network-graph-row'); row.append(el('span', 'network-row-sub', `${edge.fromPort} → ${stepName(byId(edge.to))}`));
        const cut = button('Remove', () => removeEdge(edge.id), 'text-button'); cut.dataset.removeEdgeFrom = edge.id; cut.setAttribute('aria-label', `Remove the arrow to ${stepName(byId(edge.to))}`); row.append(cut); outgoing.append(row);
      }
      const reached = reach.length ? reach.map(ref => `${stepName(byId(ref.node))} (${ref.port})`).join(', ') : 'Nothing: it starts with the run input only.';
      box.append(el('h4', '', 'Ports'), note(`Receives on: input${into.length ? '' : ' (no arrow yet: it starts when the run starts)'}.`), ...(into.length ? [incoming] : []),
        note(PORTS[node.type].length ? `Sends on: ${PORTS[node.type].map(port => `${port} (${PORT_NAMES[port]})`).join(', ')}.` : 'Sends on: nothing. An output ends its pipeline.'), ...(out.length ? [outgoing] : []),
        el('h4', '', 'What reaches it'), note(reached, 'note network-pipeline-reach'));
      return box;
    }
    function connectForm(node) {
      if (!PORTS[node.type].length) return [];
      const others = ed.nodes.filter(item => item.id !== node.id);
      const port = select(PORTS[node.type].map(name => [name, `${name} (${PORT_NAMES[name]})`])); port.id = 'network-pipeline-connect-port';
      const to = select(others.length ? others.map(item => [item.id, stepName(item)]) : [['', 'No other step yet']]); to.id = 'network-pipeline-connect-to'; to.disabled = !others.length;
      const add = button('Add arrow', () => { if (addEdge(node.id, port.value, to.value)) document.querySelector('#network-pipeline-connect-add')?.focus(); }, 'secondary-button'); add.id = 'network-pipeline-connect-add'; add.disabled = !others.length;
      if (!others.length) add.title = 'Add another step first.';
      const box = el('fieldset', 'network-connect'); box.append(el('legend', '', `Add an arrow from “${clip(stepName(node), 40)}”`), labelled('From port', port), labelled('To the step that runs after it', to), add);
      return [box];
    }
    function stepDetails(node) {
      const parts = [note(`${TYPE_NAMES[node.type]} step. ${HELP[node.type]}`)];
      const why = issueText(node.id);
      if (ed.problems.has(node.id) && (ed.validation?.error || ed.error)) { const refused = el('p', 'network-stale', `${ed.validation?.error ? 'Validate refused it' : 'Not saved'}: ${(ed.validation?.error || ed.error).message}`); refused.id = 'network-pipeline-step-refused'; parts.push(refused); }
      for (const text of why) { const warning = el('p', 'network-stale', text); warning.dataset.stepWarning = node.id; parts.push(warning); }
      const label = textInput('network-pipeline-label', node.label);
      label.placeholder = node.type === 'agent' ? agentName(node.config.agentId) : TYPE_NAMES[node.type];
      bind(label, () => { const value = label.value.trim(); return /[\r\n\t]/.test(value) || value === node.label ? undefined : value; }, value => { node.label = value; }, 'Renamed the step. Save the draft to keep it.');
      parts.push(labelled('Label (optional)', label), ...configForm(node), portsOf(node), ...connectForm(node));
      const facts = el('dl', 'network-facts');
      for (const [term, value] of [['Step ID', el('code', '', node.id)], ['Position', `${Math.round(node.position.x)}, ${Math.round(node.position.y)}`]]) { const dd = el('dd'); dd.append(value); facts.append(el('dt', '', term), dd); }
      const remove = button('Remove step', () => removeStep(node.id), 'secondary-button network-danger'); remove.id = 'network-pipeline-node-remove';
      parts.push(facts, remove);
      return parts;
    }
    function configForm(node) {
      const config = node.config;
      if (node.type === 'agent') {
        const members = ed.members?.agents || [], options = members.map(member => [member.id, agentName(member.id)]);
        if (config.agentId && !members.some(member => member.id === config.agentId)) options.push([config.agentId, `${agentName(config.agentId)} (not in network version ${ed.networkVersion})`]);
        const agent = select([['', 'Choose an agent', true], ...options]); agent.id = 'network-pipeline-agent'; agent.value = config.agentId || '';
        const view = ed.agents.get(config.agentId), web = !view?.providerCapabilities?.jobTools || view.providerCapabilities.jobTools.includes('web');
        const tools = select([['none', 'No tools'], ['web', `Read-only web search${web ? '' : ' (its provider cannot)'}`]]); tools.id = 'network-pipeline-tools'; tools.value = config.tools;
        const instructions = Object.assign(el('textarea'), { rows: 5, maxLength: 32768, value: config.instructions }); instructions.id = 'network-pipeline-instructions';
        const timeout = Object.assign(el('input'), { type: 'number', min: 1, max: 120, step: 1, placeholder: 'Job default', value: config.timeoutMs ? String(Math.round(config.timeoutMs / 60000)) : '' }); timeout.id = 'network-pipeline-timeout';
        const retries = select([['0', 'No retry'], ['1', '1 retry'], ['2', '2 retries']]); retries.id = 'network-pipeline-retries'; retries.value = String(config.retries);
        const errors = el('div');
        bind(agent, () => agent.value || undefined, value => { config.agentId = value; }, value => `The step runs “${agentName(value)}”.`);
        bind(tools, () => tools.value, value => { config.tools = value; });
        bind(instructions, () => (instructions.value === config.instructions ? undefined : instructions.value), value => { config.instructions = value; }, 'Saved the instructions in the working copy. Save the draft to keep them.');
        bind(timeout, () => { if (!timeout.value) return null; const value = Number(timeout.value); if (!Number.isInteger(value) || value < 1 || value > 120) { errors.replaceChildren(fieldError('A step time limit is 1 to 120 minutes, or empty for the job default.')); return undefined; } errors.replaceChildren(); return value * 60000; }, value => { config.timeoutMs = value; });
        bind(retries, () => Number(retries.value), value => { config.retries = value; });
        const open = config.agentId && host.openAgent ? button('Open agent profile', () => host.openAgent(config.agentId), 'text-button') : null; if (open) open.id = 'network-pipeline-open-agent';
        return [labelled('Agent', agent), ...(open ? [open] : []), labelled('Instructions for this step', instructions), labelled('Tools', tools), labelled('Time limit in minutes', timeout), labelled('If it fails', retries), errors,
          note('A retry is a new job, only after a definite failure that could not reach outside. An unknown outcome never retries on its own.')];
      }
      if (node.type === 'subnetwork') {
        const pipe = ed.pipes.get(config.pipelineId), choose = button(config.pipelineId ? 'Choose another…' : 'Choose the sub-pipeline…', () => void subnetworkDialog(node), 'secondary-button'); choose.id = 'network-pipeline-choose-sub';
        const parts = [note(config.pipelineId ? `Runs “${pipe?.name || config.pipelineId}” version ${config.version}, collapsed here. A run expands it into its own steps.` : 'No sub-pipeline chosen yet.'), choose];
        if (config.pipelineId) {
          const inside = button(ed.inside === node.id ? 'Hide its steps' : 'Show its steps', () => { ed.inside = ed.inside === node.id ? null : node.id; renderDetails(); }, 'text-button'); inside.id = 'network-pipeline-inside';
          const open = button('Open its pipeline', () => go(`#/network/pipelines/${config.pipelineId}`), 'text-button'); open.id = 'network-pipeline-open-sub';
          const actions = el('div', 'network-record-actions'); actions.append(inside, open); parts.push(actions);
          if (ed.inside === node.id) parts.push(insideList(config.pipelineId, config.version));
        }
        return parts;
      }
      if (node.type === 'condition') return conditionForm(node);
      if (node.type === 'join') {
        const require = select([['all', 'All steps before it'], ['any', 'The first step that arrives']]); require.id = 'network-pipeline-require'; require.value = config.require;
        bind(require, () => require.value, value => { config.require = value; });
        return [labelled('Goes on after', require)];
      }
      if (node.type === 'approval') {
        const prompt = Object.assign(el('textarea'), { rows: 3, maxLength: 2000, value: config.prompt }); prompt.id = 'network-pipeline-prompt';
        bind(prompt, () => (prompt.value === config.prompt ? undefined : prompt.value), value => { config.prompt = value; });
        return [labelled('What you are asked', prompt), note('Only you can approve, from the run. Nothing approves it on its own: not a restart, a timer or a result.')];
      }
      if (node.type === 'output') {
        const name = textInput('network-pipeline-output-name', config.name, 60), errors = el('div');
        bind(name, () => { const value = name.value.trim(); if (!STEM.test(value)) { errors.replaceChildren(fieldError('A report name is a file name: letters, digits, _ and -, at most 60, starting with a letter or digit.')); return undefined; } errors.replaceChildren(); return value === config.name ? undefined : value; }, value => { config.name = value; });
        const reach = reaching(ed.nodes, ed.edges).get(node.id) || [], box = el('fieldset', 'network-connect network-pipeline-include'); box.append(el('legend', '', 'In the report, in this order'));
        const candidates = topo(ed.nodes.map(item => item.id), ed.edges.map(edge => [edge.from, edge.to])).map(byId).filter(item => item.id !== node.id && ['agent', 'subnetwork', 'output'].includes(item.type));
        for (const item of candidates) {
          const box2 = Object.assign(el('input'), { type: 'checkbox', checked: config.include.includes(item.id) }); box2.id = `network-pipeline-include-${item.id}`; box2.dataset.include = item.id;
          box2.addEventListener('change', () => change(() => { config.include = box2.checked ? [...config.include, item.id].slice(0, 50) : config.include.filter(id => id !== item.id); }));
          const row = el('label', 'check-row'); row.append(box2, `${stepName(item)}${reach.some(ref => ref.node === item.id) ? '' : ' (its result does not reach here yet)'}`); box.append(row);
        }
        if (!candidates.length) box.append(note('Add agent steps first.'));
        return [labelled('Report name (saved as <name>.md)', name), errors, box];
      }
      return [note('It has nothing to set: it passes on what reached it.')];
    }
    function insideList(pipelineId, number) {
      const box = el('div', 'network-inside'); box.id = 'network-pipeline-inside-list'; box.setAttribute('aria-live', 'polite'); box.append(note('Loading…'));
      void pipelineVersion(pipelineId, number).then(version => {
        if (!box.isConnected) return;
        const order = topo(version.nodes.map(node => node.id), version.edges.map(edge => [edge.from, edge.to])), byStep = new Map(version.nodes.map(node => [node.id, node]));
        const list = el('ol', 'network-graph-list'); list.setAttribute('aria-label', `Steps of version ${number}`);
        for (const id of order.slice(0, LIST_PAGE)) { const node = byStep.get(id); list.append(el('li', 'network-row-sub', `${MARKS[node.type]} ${node.label || (node.type === 'agent' ? agentName(node.config.agentId) : TYPE_NAMES[node.type])} · ${TYPE_NAMES[node.type]}`)); }
        box.replaceChildren(note(`“${version.name}” version ${number}: ${plural(version.nodes.length, 'step')}, read only.`), list);
      }, failure => { if (box.isConnected) box.replaceChildren(el('p', 'inline-error', failure.message)); });
      return box;
    }
    /** The declarative rule editor: Task 09's operators over upstream json results; no code anywhere (architecture §20 item 4). */
    function conditionForm(node) {
      const mode = node.config.any ? 'any' : 'all';
      if (!ed.rules.has(node.id)) ed.rules.set(node.id, (node.config[mode] || []).map(ruleDraft));
      const drafts = ed.rules.get(node.id), reach = reaching(ed.nodes, ed.edges).get(node.id) || [];
      const agentSteps = ed.nodes.filter(item => item.type === 'agent' && item.id !== node.id);
      const modeSelect = select([['all', 'All rules match'], ['any', 'Any rule matches']]); modeSelect.id = 'network-pipeline-mode'; modeSelect.value = mode;
      /** Store the rows when every row is complete; otherwise keep them here and mark the step (a save waits for them). */
      const commit = (message = '') => {
        const built = drafts.map(ruleOf), config = { [modeSelect.value]: built.map(item => item.rule) };
        if (built.some(item => item.error) || JSON.stringify(config) === JSON.stringify(node.config)) { renderEditor(); return; }
        change(() => { node.config = config; ed.rules.set(node.id, drafts); }, message);
      };
      modeSelect.addEventListener('change', () => commit(modeSelect.value === 'all' ? 'The condition is true when all rules match.' : 'The condition is true when any rule matches.'));
      const rows = el('ol', 'network-rules'); rows.id = 'network-pipeline-rules'; rows.setAttribute('aria-label', 'Rules');
      drafts.forEach((draft, index) => {
        const prefix = `network-pipeline-rule-${index}`, row = el('li', 'network-rule'), result = ruleOf(draft);
        const stepPick = select([['', 'Choose a step', true], ...agentSteps.map(item => [item.id, stepName(item)])]); stepPick.id = `${prefix}-step`; stepPick.value = draft.step;
        const fields = textInput(`${prefix}-fields`, draft.fields, 600); fields.placeholder = 'for example score or result.tags';
        const op = select(OPERATORS); op.id = `${prefix}-op`; op.value = draft.op;
        const type = select(VALUE_TYPES); type.id = `${prefix}-type`; type.value = draft.type;
        const value = textInput(`${prefix}-value`, draft.raw, 1000);
        const numeric = ['lt', 'lte', 'gt', 'gte'].includes(draft.op);
        const remove = button('Remove rule', () => { drafts.splice(index, 1); commit('Removed the rule.'); }, 'text-button'); remove.id = `${prefix}-remove`;
        for (const [control, key] of [[stepPick, 'step'], [fields, 'fields'], [op, 'op'], [type, 'type'], [value, 'raw']]) control.addEventListener('change', () => { draft[key] = control.value; commit(); });
        const where = el('div', 'network-rule-grid');
        where.append(labelled('Step', stepPick), labelled('Field path in its json (empty for the whole result)', fields), labelled('Operator', op), ...(draft.op === 'exists' ? [] : [...(numeric ? [] : [labelled('Value type', type)]), labelled(draft.op === 'in' ? 'Values, separated by commas' : numeric ? 'Number' : 'Value', value)]));
        row.append(el('span', 'network-rule-title', `Rule ${index + 1}`), where);
        if (result.error) { const error = fieldError(result.error); error.id = `${prefix}-error`; row.append(error); }
        else if (draft.step && !reach.some(ref => ref.node === draft.step && ref.port === 'json')) row.append(note(`No json arrow from “${stepName(byId(draft.step))}” reaches this condition yet: connect its json port on the way, or Validate refuses it.`, 'note network-field-warning'));
        else row.append(note(`Reads ${result.rule.path}${result.rule.op === 'exists' ? ' and checks that it exists' : ` and checks that it ${OPERATORS.find(([key]) => key === result.rule.op)[1]} ${JSON.stringify(result.rule.value)}`}. A missing value matches nothing.`, 'note network-rule-summary'));
        row.append(remove); rows.append(row);
      });
      const add = button('Add rule', () => { drafts.push({ step: agentSteps[0]?.id || '', fields: '', op: 'exists', type: 'text', raw: '' }); commit('Added a rule. Set its field, operator and value.'); document.querySelector(`#network-pipeline-rule-${drafts.length - 1}-fields`)?.focus(); }, 'secondary-button'); add.id = 'network-pipeline-rule-add';
      if (drafts.length >= 20) { add.disabled = true; add.title = 'A condition has at most 20 rules.'; }
      return [labelled('The condition is true when', modeSelect), rows, ...(drafts.length ? [] : [note('No rules yet. A rule reads a field of an earlier agent step’s json result and compares it with a fixed value.')]), add,
        note('Operators are fixed (equals, less than, one of, exists, contains…): no code runs. The run goes on along “true” or “false”; the other branch is skipped.')];
    }
    function edgeDetails(edge) {
      const from = byId(edge.from), to = byId(edge.to), reach = reaching(ed.nodes, ed.edges).get(edge.from) || [];
      const carries = from.type === 'agent' ? `“${stepName(from)}”’s ${edge.fromPort} result` : ['subnetwork', 'output'].includes(from.type) ? `“${stepName(from)}”’s report text`
        : reach.length ? `what reached “${stepName(from)}”: ${reach.map(ref => `${stepName(byId(ref.node))} (${ref.port})`).join(', ')}` : 'nothing but the order';
      const parts = [note(`From “${stepName(from)}” on port ${edge.fromPort} to “${stepName(to)}” on port input. “${stepName(to)}” runs after it${from.type === 'condition' ? `, ${edge.fromPort === 'true' ? 'only when the rules are true' : 'only when the rules are false'}` : ''}.`),
        Object.assign(note(`Carries ${carries}.`, 'note network-pipeline-carries'), { id: 'network-pipeline-carries' }), note('An execution arrow is not a Graph relation: it is the only way a result moves from one step to another.', 'note network-inert')];
      if (ed.badEdges.has(edge.id)) parts.unshift(el('p', 'network-stale', `Refused: ${(ed.validation?.error || ed.error)?.message || ''}`));
      const remove = button('Remove arrow', () => removeEdge(edge.id), 'secondary-button network-danger'); remove.id = 'network-pipeline-edge-remove';
      return [...parts, remove];
    }

    // ---- Canvas (Cytoscape), one for the designer (`d`) and one for the run view (`r`); never on a phone.
    function styleSheet() {
      const ink = css('--ink', '#16161a'), surface = css('--surface', '#fff'), raised = css('--surface-2', '#f1f1f4'), line = css('--line-strong', '#85858f'), muted = css('--muted', '#4f4f58');
      const ok = css('--og-ok', '#047857'), warn = css('--og-warn', '#b45309'), error = css('--error', '#c2410c'), accent = css('--sash', '#7c3aed'), blue = css('--og-design', '#2563eb');
      return [
        { selector: 'node', style: { shape: 'rectangle', width: 172, height: 58, 'background-color': surface, 'border-width': 2, 'border-color': line, label: 'data(label)', color: ink, 'font-size': 14,
          'font-family': css('--sans', 'sans-serif'), 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 156, 'line-height': 1.25, 'min-zoomed-font-size': 6 } },
        { selector: 'node[type = "subnetwork"]', style: { shape: 'barrel', width: 184, height: 64, 'border-style': 'double', 'border-width': 6, 'background-color': raised } },
        { selector: 'node[type = "parallel"]', style: { shape: 'concave-hexagon', width: 160, height: 54, 'background-color': raised } },
        { selector: 'node[type = "join"]', style: { shape: 'hexagon', width: 160, height: 54, 'background-color': raised } },
        { selector: 'node[type = "condition"]', style: { shape: 'diamond', width: 176, height: 100, 'text-max-width': 110 } },
        { selector: 'node[type = "approval"]', style: { shape: 'octagon', width: 168, height: 68 } },
        { selector: 'node[type = "output"]', style: { shape: 'cut-rectangle', width: 172, height: 58, 'border-width': 3 } },
        { selector: 'node.group', style: { shape: 'round-rectangle', 'text-valign': 'top', 'text-margin-y': 24, padding: 30, 'background-opacity': 0.35, 'border-style': 'dashed', 'border-width': 2,
          'text-wrap': 'ellipsis', 'text-max-width': 320, 'text-background-color': raised, 'text-background-opacity': 1, 'text-background-padding': 3, 'text-background-shape': 'roundrectangle' } },
        { selector: 'node.warn', style: { 'border-color': warn, 'border-width': 3 } },
        { selector: 'node.problem', style: { 'border-color': error, 'border-width': 5 } },
        { selector: 'node.s-running', style: { 'border-color': blue, 'border-width': 5 } },
        { selector: 'node.s-completed', style: { 'border-color': ok, 'border-width': 4 } },
        { selector: 'node.s-waiting_for_approval', style: { 'border-color': warn, 'border-width': 6, 'border-style': 'double' } },
        { selector: 'node.s-blocked', style: { 'border-color': warn, 'border-width': 4, 'border-style': 'dashed' } },
        { selector: 'node.s-failed', style: { 'border-color': error, 'border-width': 5 } },
        { selector: 'node.s-skipped, node.s-cancelled', style: { opacity: 0.55, 'border-style': 'dashed' } },
        { selector: 'node:selected', style: { 'overlay-color': accent, 'overlay-opacity': 0.14, 'overlay-padding': 7 } },
        { selector: 'node.source', style: { 'border-color': accent, 'border-width': 6 } },
        // Execution arrows: solid and right-angled, labelled with the port they leave on (Graph relations are dashed curves).
        { selector: 'edge', style: { width: 2.4, 'curve-style': 'taxi', 'taxi-direction': 'horizontal', 'line-style': 'solid', 'line-color': line, 'target-arrow-color': line, 'target-arrow-shape': 'triangle-backcurve', 'arrow-scale': 1.3,
          label: 'data(label)', 'font-size': 12, 'font-family': css('--mono', 'monospace'), color: muted, 'text-background-color': surface, 'text-background-opacity': 1, 'text-background-padding': 2, 'min-zoomed-font-size': 8 } },
        { selector: 'edge[port = "json"]', style: { 'line-color': blue, 'target-arrow-color': blue } },
        { selector: 'edge[port = "true"]', style: { 'line-color': ok, 'target-arrow-color': ok } },
        { selector: 'edge[port = "false"]', style: { 'line-color': warn, 'target-arrow-color': warn } },
        { selector: 'edge.problem', style: { 'line-color': error, 'target-arrow-color': error, width: 4.5 } },
        { selector: 'edge:selected', style: { width: 4, 'overlay-opacity': 0 } },
      ];
    }
    const canvases = { d: { host: dCanvas, get cy() { return dCy; }, set cy(value) { dCy = value; }, key: null }, r: { host: null, cy: null, key: null } };
    function destroyCanvas(which) { const slot = canvases[which]; if (slot.cy) { slot.cy.destroy(); slot.cy = null; slot.key = null; } slot.host?.replaceChildren(); }
    /** Tell the canvas its size changed, only when it did (a resize redraws everything). */
    function fitSize(which) { const slot = canvases[which], size = `${slot.host.clientWidth}x${slot.host.clientHeight}`; if (slot.size !== size) { slot.size = size; slot.cy.resize(); } }
    function fitView(cy) { if (!cy) return; cy.fit(undefined, 40); if (cy.zoom() > 1.2) { cy.zoom(1.2); cy.center(); } }
    function zoomBy(cy, factor) { if (!cy) return; cy.zoom({ level: Math.min(3, Math.max(0.05, cy.zoom() * factor)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); }
    function makeCanvas(which, key, readOnly) {
      const slot = canvases[which], big = which === 'd' ? ed.nodes.length > 300 : false;
      destroyCanvas(which);
      slot.cy = window.cytoscape({ container: slot.host, style: styleSheet(), elements: [], layout: { name: 'preset' }, minZoom: 0.05, maxZoom: 3, boxSelectionEnabled: false, selectionType: 'single',
        autoungrabify: readOnly, textureOnViewport: big, hideEdgesOnViewport: big, motionBlur: false });
      slot.key = key; slot.size = `${slot.host.clientWidth}x${slot.host.clientHeight}`;
      return slot.cy;
    }
    function drawCanvas(which) {
      if (which === 'd') {
        if (!ed || ed.loading || ed.loadError || !window.cytoscape || isPhone() || designer.hidden || panel.hidden) return;
        if (dCy && canvases.d.key === ed.key) { fitSize('d'); syncDesigner(); return; }
        const cy = makeCanvas('d', ed.key, false);
        cy.on('tap', 'node, edge', event => onTap(event.target.id()));
        cy.on('tap', event => { if (event.target === cy && !ed.connect) selectItem(null); });
        cy.on('dbltap', 'node', event => { const node = byId(event.target.id()); if (node?.type === 'subnetwork' && node.config.pipelineId) { selectItem(node.id); ed.inside = node.id; renderDetails(); } });
        cy.on('grab', 'node', () => { dragStart = snapshot(); });
        cy.on('dragfree', 'node', event => onDragged(event.target));
        syncDesigner();
        if (ed.nodes.length) fitView(cy); else cy.center();
        return;
      }
      drawRunCanvas();
    }
    function canvasSub(node) {
      const config = node.config;
      return { agent: () => (node.label ? agentName(config.agentId) : 'Agent'), subnetwork: () => (config.pipelineId ? `Sub-pipeline · v${config.version}` : 'Sub-pipeline · not chosen'),
        condition: () => `Condition · ${plural((config.all || config.any || []).length, 'rule')}`, join: () => `Join · ${config.require === 'any' ? 'first' : 'all'}`, parallel: () => 'Parallel',
        approval: () => 'Approval', output: () => `Output · ${config.name}.md` }[node.type]();
    }
    function labelOf(node) { return `${MARKS[node.type]} ${clip(stepName(node), 40)}\n${clip(canvasSub(node), 34)}`; }
    /** Make the designer canvas show the working copy: add, update and remove only what differs, in one batch. */
    function syncDesigner() {
      if (!dCy || !ed) return;
      const nodes = new Map(ed.nodes.map(node => [node.id, node])), edges = new Set(ed.edges.map(edge => edge.id)), warned = new Set(ed.issues.map(issue => issue.nodeId));
      const classes = node => [ed.problems.has(node.id) ? 'problem' : warned.has(node.id) ? 'warn' : '', ed.connect?.from === node.id ? 'source' : ''].filter(Boolean).join(' ');
      dCy.batch(() => {
        dCy.edges().filter(item => !edges.has(item.id())).remove();
        dCy.nodes().filter(item => !nodes.has(item.id())).remove();
        const added = [];
        for (const node of ed.nodes) {
          const item = dCy.getElementById(node.id);
          if (item.empty()) { added.push({ group: 'nodes', data: { id: node.id, type: node.type, label: labelOf(node) }, position: { ...node.position }, classes: classes(node) }); continue; }
          const label = labelOf(node), names = classes(node); // Only what changed: every write restyles the element.
          if (item.data('label') !== label || item.data('type') !== node.type) item.data({ label, type: node.type });
          if (item.classes().join(' ') !== names) item.classes(names);
          const at = item.position(); if (Math.abs(node.position.x - at.x) > 0.5 || Math.abs(node.position.y - at.y) > 0.5) item.position({ ...node.position });
        }
        dCy.add(added); added.length = 0;
        for (const edge of ed.edges) {
          const item = dCy.getElementById(edge.id), data = { id: edge.id, source: edge.from, target: edge.to, port: edge.fromPort, label: edge.fromPort }, bad = ed.badEdges.has(edge.id) ? 'problem' : '';
          if (item.empty()) added.push({ group: 'edges', data, classes: bad }); else if (item.classes().join(' ') !== bad) item.classes(bad);
        }
        dCy.add(added);
        const chosen = ed.selected && ed.selected !== SETTINGS ? ed.selected : null;
        dCy.elements(':selected').filter(item => item.id() !== chosen).unselect(); if (chosen) dCy.getElementById(chosen).select();
      });
    }
    function onDragged(item) {
      const node = byId(item.id()); if (!node || !dragStart) return;
      const at = item.position(), next = { x: Math.round(at.x), y: Math.round(at.y) };
      if (next.x === node.position.x && next.y === node.position.y) return;
      const before = dragStart; dragStart = null;
      change(() => { node.position = next; }, '', before);
    }
    function onTap(id) {
      if (!ed.connect) { selectItem(id); return; }
      if (!byId(id)) { say('Choose a step, not an arrow.'); return; }
      if (!ed.connect.from) {
        const node = byId(id);
        if (!PORTS[node.type].length) { say('An output step ends its pipeline: no arrow leaves it. Choose the step the arrow starts from.'); return; }
        ed.connect.from = id; dPort.replaceChildren(...select(PORTS[node.type].map(port => [port, `${port} (${PORT_NAMES[port]})`])).children);
        say(`Connecting from “${stepName(node)}” on port ${dPort.value}: choose the step that runs after it. Escape stops.`); syncDesigner(); renderEditor(); return;
      }
      if (addEdge(ed.connect.from, dPort.value, id)) stopConnect('');
    }
    function toggleConnect() {
      if (!ed) return;
      if (ed.connect) { stopConnect(); return; }
      const from = byId(ed.selected) && PORTS[byId(ed.selected).type].length ? ed.selected : null;
      ed.connect = { from };
      if (from) dPort.replaceChildren(...select(PORTS[byId(from).type].map(port => [port, `${port} (${PORT_NAMES[port]})`])).children);
      else dPort.replaceChildren();
      say(from ? `Connecting from “${stepName(byId(from))}”: choose its port beside Connect, then the step that runs after it. Escape stops.` : 'Connect: choose the step the arrow starts from, then the step that runs after it. Escape stops.');
      syncDesigner(); renderEditor(); dCanvas.focus();
    }
    function stopConnect(message = 'Stopped connecting.') { if (!ed?.connect) return; ed.connect = null; if (message) say(message); syncDesigner(); renderEditor(); }
    dCanvas.addEventListener('keydown', event => {
      if (!ed || ed.loading) return;
      const step = event.shiftKey ? 50 : 10, move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key], node = byId(ed.selected);
      if (move && node) { event.preventDefault(); change(() => { node.position = { x: node.position.x + move[0], y: node.position.y + move[1] }; }); return; }
      if (['Delete', 'Backspace'].includes(event.key) && ed.selected && ed.selected !== SETTINGS) { event.preventDefault(); removeSelected(); return; }
      if (event.key === 'Escape') { event.preventDefault(); if (ed.connect) stopConnect(); else selectItem(null); }
    });

    // ---- Run view: one run of one pinned version, its steps' live states, approvals, jobs, artifacts and reports.
    const rHeading = el('h2', '', ''); rHeading.id = 'network-run-heading'; rHeading.tabIndex = -1;
    const rMeta = el('div', 'network-chips network-graph-meta'); rMeta.id = 'network-run-meta';
    const rAll = button('All pipelines', () => go('#/network/pipelines'), 'text-button network-pipeline-all'); rAll.id = 'network-run-all';
    const rTitle = el('div', 'network-graph-title'); rTitle.append(rAll, rHeading, rMeta);
    const rOpen = button('Open the pipeline', () => go(`#/network/pipelines/${rv.plan.pipeline.id}`), 'secondary-button'); rOpen.id = 'network-run-open-pipeline';
    const rCancel = button('Cancel run…', () => cancelDialog(), 'secondary-button network-danger'); rCancel.id = 'network-run-cancel';
    const rActions = el('div', 'detail-actions network-graph-actions'); rActions.append(rOpen, rCancel);
    const rHead = el('header', 'network-graph-head'); rHead.append(rTitle, rActions);
    const rPinned = note('', 'note network-inert'); rPinned.id = 'network-run-pinned';
    const rSummary = el('p', 'network-run-summary'); rSummary.id = 'network-run-summary'; rSummary.setAttribute('aria-live', 'polite');
    const rFit = button('Fit', () => fitView(canvases.r.cy), 'secondary-button'); rFit.id = 'network-run-fit';
    const rZoomOut = button('−', () => zoomBy(canvases.r.cy, 1 / 1.25), 'secondary-button'); rZoomOut.id = 'network-run-zoom-out'; rZoomOut.setAttribute('aria-label', 'Zoom out');
    const rZoomIn = button('+', () => zoomBy(canvases.r.cy, 1.25), 'secondary-button'); rZoomIn.id = 'network-run-zoom-in'; rZoomIn.setAttribute('aria-label', 'Zoom in');
    const rCollapse = button('Collapse all', () => { rv.expanded.clear(); syncRun(true); renderRun(); }, 'secondary-button'); rCollapse.id = 'network-run-collapse';
    const rTools = el('div', 'network-graph-toolbar'); const rView = el('div', 'network-graph-tools network-canvas-tools'); rView.append(rFit, rZoomOut, rZoomIn, rCollapse); rTools.append(rView);
    const rCanvas = el('div', 'network-canvas network-run-canvas'); rCanvas.id = 'network-run-canvas'; rCanvas.tabIndex = 0; rCanvas.setAttribute('role', 'application'); rCanvas.setAttribute('aria-roledescription', 'run canvas'); rCanvas.setAttribute('aria-describedby', 'network-run-canvas-hint');
    canvases.r.host = rCanvas;
    const rHint = note('Each step shows its live status. Double-click a sub-pipeline to expand or collapse its steps. The list beside the canvas holds the same steps in execution order.', 'note network-canvas-hint'); rHint.id = 'network-run-canvas-hint';
    const rCanvasBox = el('div', 'network-canvas-box'); rCanvasBox.append(rCanvas, rHint);
    const rAlert = el('div', 'inline-error network-alert'); rAlert.id = 'network-run-alert'; rAlert.setAttribute('role', 'alert'); rAlert.hidden = true;
    const rDetails = el('section', 'network-graph-details'); rDetails.id = 'network-run-details'; rDetails.setAttribute('aria-label', 'Step details');
    const rStepsTitle = el('h3', '', 'Steps'); rStepsTitle.id = 'network-run-steps-title';
    const rSteps = el('ul', 'network-graph-list'); rSteps.id = 'network-run-steps'; rSteps.setAttribute('aria-labelledby', rStepsTitle.id);
    const rLists = el('div', 'network-graph-lists'); rLists.append(rStepsTitle, rSteps);
    const rSide = el('aside', 'network-graph-side'); rSide.setAttribute('aria-label', 'Steps and details'); rSide.append(rAlert, rDetails, rLists);
    const rBody = el('div', 'network-graph-body'); rBody.append(rCanvasBox, rSide);
    runView.append(rHead, rPinned, rSummary, rTools, rBody);

    let rv = null;
    const step = id => rv.steps.get(id);
    const group = id => rv.groups.get(id);
    /** The groups a step is inside, outermost first. */
    const chain = id => { const list = []; for (let g = step(id)?.group ?? group(id)?.parent; g; g = group(g)?.parent) list.unshift(g); return list; };
    /** What stands for a step on the canvas: the outermost collapsed group around it, or the step itself. */
    const shown = id => chain(id).find(g => !rv.expanded.has(g)) || id;
    const runStepName = id => { const node = step(id); return node?.label || (node?.type === 'output' ? `Output “${node.config.name}”` : TYPE_NAMES[node?.type]) || id; };
    /** A group's status from its steps: running, waiting, blocked, failed, completed (all ended), or waiting to start. */
    function groupStatus(id) {
      const states = rv.plan.nodes.filter(node => chain(node.id).includes(id)).map(node => rv.run.nodes[node.id].status), has = status => states.includes(status);
      return has('running') || has('ready') ? 'running' : has('waiting_for_approval') ? 'waiting_for_approval' : has('blocked') ? 'blocked' : has('failed') ? 'failed'
        : states.every(status => ['completed', 'skipped'].includes(status)) ? 'completed' : states.every(status => ['completed', 'skipped', 'cancelled'].includes(status)) ? 'cancelled' : 'pending';
    }
    async function openRun(runId) {
      if (rv?.runId === runId) return;
      leaveRun();
      const mine = rv = { runId, loading: true, loadError: null, run: null, plan: null, jobs: new Map(), worker: true, positions: new Map(), agents: new Map(), expanded: new Set(), selected: null, phoneDetail: false, error: null, report: null, stop: null };
      renderRun();
      try { await refreshRun(); } catch (failure) { if (rv === mine) mine.loadError = failure; }
      if (rv !== mine) return;
      if (!mine.loadError) {
        // Positions come from the pinned version as published; a sub-pipeline's steps are laid out in columns when expanded.
        const [version, agents] = await Promise.all([pipelineVersion(mine.plan.pipeline.id, mine.plan.pipeline.version).catch(() => null), request('/api/network/agents?limit=200').catch(() => null)]);
        if (rv !== mine) return;
        if (version) mine.positions = new Map(version.nodes.map(node => [node.id, node.position]));
        if (agents) mine.agents = new Map(agents.agents.map(agent => [agent.id, agent]));
      }
      mine.loading = false;
      renderRun();
      rHeading.focus();
      follow();
    }
    function follow() { if (rv && !rv.stop && MOVING.has(rv.run?.status)) { const mine = rv; rv.stop = followRun(rv.runId, async () => { if (rv !== mine) return false; await refreshRun(); const again = MOVING.has(mine.run.status); if (!again) mine.stop = null; return again; }); } }
    function leaveRun() { rv?.stop?.(); rv = null; destroyCanvas('r'); }
    /** Read the run (and its step jobs) again and redraw only what changed. Answers whether it is still moving. */
    async function refreshRun() {
      const mine = rv;
      let data;
      try { data = await request(`/api/network/pipeline-runs/${mine.runId}`); }
      catch (failure) { if (rv === mine && mine.run) { mine.error = { message: `Could not read the run just now. ${failure.message}` }; renderRunSide(); return true; } throw failure; }
      const jobs = Object.values(data.run.nodes).some(node => node.jobIds.length) ? await request(`/api/network/jobs?pipelineRunId=${mine.runId}&limit=200`).catch(() => null) : null;
      if (rv !== mine) return false;
      Object.assign(mine, { run: data.run, plan: data.plan, error: null });
      if (!mine.steps || mine.planSha256 !== data.run.planSha256) Object.assign(mine, { planSha256: data.run.planSha256, steps: new Map(data.plan.nodes.map(node => [node.id, node])), groups: new Map(data.plan.groups.map(item => [item.id, item])) });
      if (jobs) Object.assign(mine, { jobs: new Map(jobs.jobs.map(job => [job.id, job])), worker: jobs.worker });
      if (!mine.loading) renderRun();
      return MOVING.has(data.run.status);
    }
    function renderRun() {
      if (!rv || runView.hidden) return;
      panel.dataset.view = rv.phoneDetail && rv.selected ? 'detail' : 'list';
      const ready = !rv.loading && !rv.loadError && rv.run;
      rTools.hidden = !ready || isPhone() || !window.cytoscape; rBody.hidden = !ready && !rv.loadError; rSummary.hidden = !ready; rPinned.hidden = !ready;
      rCollapse.hidden = !ready || !rv.plan.groups.length; rCollapse.disabled = !rv.expanded.size; rCollapse.title = rv.expanded.size ? '' : 'Every sub-pipeline is collapsed.';
      rOpen.hidden = !ready; rCancel.hidden = !ready || !MOVING.has(rv.run.status);
      if (rv.loadError) { rHeading.textContent = 'Run not available'; rMeta.replaceChildren(); rAlert.hidden = false; rAlert.replaceChildren(el('span', '', rv.loadError.message), button('All pipelines', () => go('#/network/pipelines'), 'secondary-button')); rCanvasBox.hidden = true; rLists.hidden = true; rDetails.hidden = true; return; }
      rCanvasBox.hidden = isPhone() || !window.cytoscape; rLists.hidden = false; rDetails.hidden = false;
      if (!ready) { rHeading.textContent = 'Loading the run…'; rMeta.replaceChildren(); return; }
      const { run, plan } = rv, states = Object.values(run.nodes), count = status => states.filter(node => node.status === status).length;
      rHeading.textContent = `${plan.pipeline.name} · run of version ${plan.pipeline.version}`;
      rMeta.replaceChildren(Object.assign(tone(RUN_STATES[run.status] || [run.status, 'off']), { id: 'network-run-status' }), chip(`Started ${ago(run.startedAt)}`, 'off'), ...(run.endedAt ? [chip(`Ended ${ago(run.endedAt)}`, 'off')] : []),
        chip(`Network version ${plan.network.version}`, 'off'));
      rPinned.textContent = `This run uses version ${plan.pipeline.version} exactly as published (plan ${run.planSha256.slice(0, 12)}, compiled ${ago(plan.compiledAt)}), with its sub-pipelines pinned. Editing or publishing the pipeline does not change it.`;
      const waiting = plan.nodes.filter(node => run.nodes[node.id].status === 'waiting_for_approval');
      rSummary.textContent = `${count('completed')} of ${plural(states.length, 'step')} completed${count('running') ? ` · ${count('running')} running` : ''}${waiting.length ? ` · waiting for your approval of ${waiting.map(node => `“${runStepName(node.id)}”`).join(', ')}` : ''}${count('failed') ? ` · ${count('failed')} failed` : ''}${count('blocked') ? ` · ${count('blocked')} blocked` : ''}${run.reason ? `. ${run.reason}` : ''}`;
      drawRunCanvas(); syncRun(false);
      renderRunSide();
    }
    function renderRunSide() {
      if (!rv?.run) return;
      rAlert.hidden = !rv.error && !rv.run.passError;
      rAlert.replaceChildren(...(rv.error ? [el('span', '', rv.error.message)] : []), ...(rv.run.passError ? [el('span', '', `The last pass over this run could not be saved (${rv.run.passError.code}): ${rv.run.passError.message} It tries again.`)] : []));
      renderRunList(); renderRunDetails();
    }
    function renderRunList() {
      keepFocus(rLists, () => {
        const rows = [], seen = new Set();
        for (const node of rv.plan.nodes) {
          let hidden = false;
          for (const [depth, g] of chain(node.id).entries()) {
            if (!seen.has(g)) { seen.add(g); rows.push(groupRow(g, depth)); }
            if (!rv.expanded.has(g)) { hidden = true; break; }
          }
          if (!hidden) rows.push(stepRow(node, chain(node.id).length));
        }
        rStepsTitle.textContent = `Steps in execution order (${rv.plan.nodes.length})`;
        rSteps.replaceChildren(...rows);
      });
    }
    function groupRow(id, depth) {
      const g = group(id), status = groupStatus(id), open = rv.expanded.has(id), inside = rv.plan.nodes.filter(node => chain(node.id).includes(id));
      const item = el('li', 'network-graph-row network-run-row'); item.dataset.depth = String(depth);
      const pick = button('', () => selectRun(id, { focus: true }), 'network-graph-item'); pick.dataset.groupId = id;
      if (rv.selected === id) pick.setAttribute('aria-current', 'true');
      const text = el('span', 'network-row-text'); text.append(el('strong', '', `${g.label} · version ${g.version}`), el('span', 'network-row-sub', `Sub-pipeline · ${inside.filter(node => rv.run.nodes[node.id].status === 'completed').length} of ${plural(inside.length, 'step')} completed`), tone(STEP_STATES[status]));
      const mark = el('span', 'network-node-mark mark-subnetwork', MARKS.subnetwork); mark.setAttribute('aria-hidden', 'true');
      pick.append(mark, text);
      const toggle = button(open ? 'Collapse' : 'Expand', () => toggleGroup(id), 'text-button'); toggle.dataset.toggleGroup = id; toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${g.label}`);
      item.append(pick, toggle);
      return item;
    }
    function stepRow(node, depth) {
      const state = rv.run.nodes[node.id], item = el('li', 'network-graph-row network-run-row'); item.dataset.depth = String(depth); item.dataset.status = state.status;
      const pick = button('', () => selectRun(node.id, { focus: true }), 'network-graph-item'); pick.dataset.stepId = node.id;
      if (rv.selected === node.id) pick.setAttribute('aria-current', 'true');
      const text = el('span', 'network-row-text');
      text.append(el('strong', '', runStepName(node.id)), el('span', 'network-row-sub', `${TYPE_NAMES[node.type]}${node.type === 'agent' ? ` · ${agentLabel(node.config.agentId)}` : ''}${state.attempt > 1 ? ` · try ${state.attempt}` : ''}`), tone(STEP_STATES[state.status] || [state.status, 'off']));
      const mark = el('span', `network-node-mark mark-${node.type}`, MARKS[node.type]); mark.setAttribute('aria-hidden', 'true');
      pick.append(mark, text); item.append(pick);
      return item;
    }
    const agentLabel = id => { const view = rv.agents.get(id); return view ? view.displayName || view.base.name || id : id; };
    function toggleGroup(id) {
      if (rv.expanded.has(id)) for (const g of [...rv.expanded]) { if (g === id || chain(g).includes(id)) rv.expanded.delete(g); } else rv.expanded.add(id);
      syncRun(true); renderRun();
    }
    function selectRun(id, { focus = false } = {}) {
      rv.selected = id; rv.report = rv.report?.nodeId === id ? rv.report : null;
      if (id && isPhone()) rv.phoneDetail = true;
      panel.dataset.view = rv.phoneDetail && rv.selected ? 'detail' : 'list';
      if (canvases.r.cy) canvases.r.cy.batch(() => { canvases.r.cy.elements(':selected').unselect(); if (id) canvases.r.cy.getElementById(shown(id)).select(); });
      renderRunSide();
      if (focus) document.querySelector('#network-run-detail-heading')?.focus();
    }
    function renderRunDetails() {
      keepFocus(rDetails, () => {
        const id = rv.selected, heading = text => { const title = el('h3', 'network-graph-detail-title', text); title.id = 'network-run-detail-heading'; title.tabIndex = -1; return title; };
        const back = button('Back to the steps', () => { const last = rv.selected; rv.phoneDetail = false; renderRun(); rLists.querySelector(`[data-step-id="${last}"], [data-group-id="${last}"]`)?.focus(); }, 'text-button network-back'); back.id = 'network-run-back';
        if (id && group(id)) { rDetails.replaceChildren(back, heading(group(id).label), ...groupDetails(id)); return; }
        if (id && step(id)) { rDetails.replaceChildren(back, heading(runStepName(id)), ...runStepDetails(step(id))); return; }
        rDetails.replaceChildren(heading('Details'), note('Choose a step on the canvas or in the list to see its status, job, inputs and results.'));
      });
    }
    function groupDetails(id) {
      const g = group(id), inside = rv.plan.nodes.filter(node => chain(node.id).includes(id)), list = el('ul', 'network-graph-list'); list.setAttribute('aria-label', `Steps of ${g.label}`);
      for (const node of inside) { const row = el('li', 'network-graph-row'), pick = button('', () => selectRun(node.id, { focus: true }), 'network-graph-item'); pick.dataset.innerStep = node.id; const text = el('span', 'network-row-text'); text.append(el('strong', '', runStepName(node.id)), tone(STEP_STATES[rv.run.nodes[node.id].status])); pick.append(text); row.append(pick); list.append(row); }
      const toggle = button(rv.expanded.has(id) ? 'Collapse its steps' : 'Expand its steps', () => toggleGroup(id), 'secondary-button'); toggle.id = 'network-run-toggle-group';
      return [note(`Sub-pipeline “${g.label}”, version ${g.version} (sha256 ${g.sha256.slice(0, 12)}), of network version ${g.networkVersion}. ${STEP_STATES[groupStatus(id)][0]}.`), toggle, list];
    }
    function runStepDetails(node) {
      const state = rv.run.nodes[node.id], parts = [], rows = [];
      const status = tone(STEP_STATES[state.status] || [state.status, 'off']); status.id = 'network-run-step-status';
      parts.push(el('p', 'network-chips', ''), note(`${TYPE_NAMES[node.type]} step${node.group ? ` inside “${group(node.group).label}”` : ''}.`));
      parts[0].append(status);
      if (state.reason || state.errorCode) { const why = el('p', ['failed', 'blocked'].includes(state.status) ? 'network-stale' : 'note', `${state.errorCode ? `${state.errorCode}: ` : ''}${state.reason || ''}`); why.id = 'network-run-step-reason'; parts.push(why); }
      if (node.type === 'approval') parts.push(...approvalPart(node, state));
      if (node.type === 'agent') {
        const view = rv.agents.get(node.config.agentId), job = state.jobId ? rv.jobs.get(state.jobId) : null;
        rows.push(['Agent', agentLabel(node.config.agentId)], ['Provider', view ? ({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', agy: 'Antigravity' }[view.base.provider] || view.base.provider || 'Not set') + (view.base.model ? ` · ${view.base.model}` : '') : 'Unknown'],
          ['Tools', node.config.tools === 'web' ? 'Read-only web search' : 'None'], ['Try', `${state.attempt || 0} of ${node.config.retries + 1}${state.jobIds.length > 1 ? ` · jobs ${state.jobIds.join(', ')}` : ''}`]);
        if (job) rows.push(['Job', `${job.status}${job.waiting?.message ? ` · ${job.waiting.message}` : ''}`], ['Worker', job.live ? `This app’s worker (process ${job.live.process})` : job.status === 'queued' ? (rv.worker ? 'Not started yet' : 'No worker in this app') : 'Not running']);
        else if (state.status === 'running') rows.push(['Job', 'Being submitted']);
      }
      if (node.type === 'condition' && state.decision) {
        const d = state.decision, list = el('ul', 'network-reasons'); list.id = 'network-run-decision';
        for (const rule of d.rules) { const item = el('li', rule.matched ? 'is-in' : 'is-out'); item.append(el('span', 'network-reason-mark', rule.matched ? '✓' : '–'), `${rule.path} ${rule.op}${rule.op === 'exists' ? '' : ` ${JSON.stringify(rule.value)}`}: found ${rule.missing ? 'nothing' : rule.actual}`); list.append(item); }
        parts.push(el('h4', '', `Decision: ${d.result ? 'true' : 'false'} (${d.mode})`), list);
      }
      if (state.inputs?.length) rows.push(['Inputs', state.inputs.map(ref => `${runStepName(ref.node)} (${ref.port})`).join(', ')]);
      if (state.result?.text) rows.push(['Result', `${state.result.text.ref} · ${state.result.text.chars.toLocaleString('en-US')} characters · sha256 ${state.result.text.sha256.slice(0, 12)}`]);
      if (state.result?.json) rows.push(['Json result', `${state.result.json.ref} · sha256 ${state.result.json.sha256.slice(0, 12)}`]);
      if (state.startedAt) rows.push(['Started', ago(state.startedAt)]); if (state.endedAt) rows.push(['Ended', ago(state.endedAt)]);
      const facts = el('dl', 'network-facts'); facts.id = 'network-run-step-facts'; for (const [label, value] of rows) facts.append(el('dt', '', label), el('dd', '', value));
      parts.push(facts);
      const actions = el('div', 'network-record-actions');
      if (state.jobId) { const open = button('Open job', () => openJob(state.jobId), 'text-button'); open.id = 'network-run-open-job'; actions.append(open); }
      if (node.type === 'agent' && host.openAgent) { const agent = button('Open agent profile', () => host.openAgent(node.config.agentId), 'text-button'); agent.id = 'network-run-open-agent'; actions.append(agent); }
      if (actions.children.length) parts.push(actions);
      if (node.type === 'output') parts.push(...reportPart(node, state));
      return parts;
    }
    function approvalPart(node, state) {
      const approval = state.approval;
      if (!approval) return [note(`It asks: “${node.config.prompt || 'Approve to go on.'}” once the steps before it are done.`)];
      const parts = [note(`It asks: “${approval.prompt || 'Approve to go on.'}”`, 'note network-quote'), note(`Asked ${ago(approval.requestedAt)}.${approval.decision ? ` You ${approval.decision} it ${ago(approval.decidedAt)}.` : ''}`)];
      if (state.status === 'waiting_for_approval' && MOVING.has(rv.run.status)) {
        const approve = button('Approve', () => void decide(node.id, 'approve'), 'secondary-button network-primary'); approve.id = 'network-run-approve';
        const reject = button('Reject', () => void decide(node.id, 'reject'), 'secondary-button network-danger'); reject.id = 'network-run-reject';
        const box = el('div', 'detail-actions network-run-decide'); box.append(approve, reject);
        parts.push(box, note('Approve lets the steps after it run. Reject cancels them and ends the run.'));
      }
      return parts;
    }
    function reportPart(node, state) {
      if (state.status !== 'completed' || !state.result?.text) return [note(`It saves “${node.file || `${node.config.name}.md`}” when the steps before it are done.`)];
      const show = button(rv.report?.nodeId === node.id ? 'Hide the report' : 'Show the report', () => void toggleReport(node.id), 'secondary-button'); show.id = 'network-run-show-report';
      const parts = [show];
      if (rv.report?.nodeId === node.id) {
        if (rv.report.error) parts.push(el('p', 'inline-error', rv.report.error));
        else {
          const body = el('div', 'md-view network-post-body network-run-report'); body.id = 'network-run-report'; body.append(window.PromptboardMarkdown.render(rv.report.text));
          const save = button('Download', () => download(rv.report.file.split('/').pop(), rv.report.text, 'text/markdown'), 'text-button'); save.id = 'network-run-download-report';
          parts.push(note(`Saved as ${rv.report.file} · sha256 ${rv.report.sha256.slice(0, 12)} · checked now.`), body, save);
        }
      }
      return parts;
    }
    async function toggleReport(nodeId) {
      if (rv.report?.nodeId === nodeId) { rv.report = null; renderRunSide(); return; }
      const mine = rv;
      try { const data = await request(`/api/network/pipeline-runs/${rv.runId}/nodes/${nodeId}/report`); if (rv === mine) rv.report = data; }
      catch (failure) { if (rv === mine) rv.report = { nodeId, error: failure.message }; }
      if (rv === mine) { renderRunSide(); document.querySelector('#network-run-show-report')?.focus(); }
    }
    async function decide(nodeId, decision) {
      const mine = rv;
      try {
        await request(`/api/network/pipeline-runs/${mine.runId}/nodes/${nodeId}/approve`, { method: 'POST', body: { decision } });
        say(decision === 'approve' ? `Approved “${runStepName(nodeId)}”. The steps after it can run now.` : `Rejected “${runStepName(nodeId)}”. The steps after it do not run.`);
        mine.error = null;
      } catch (failure) { if (rv === mine) mine.error = failure; }
      if (rv !== mine) return;
      await refreshRun().catch(() => {});
      follow();
      document.querySelector('#network-run-detail-heading')?.focus();
    }
    function cancelDialog() {
      ask('Cancel this run?', [note('Its open steps are cancelled and their jobs are stopped through the job engine. Results already saved stay; nothing is undone. A blocked step keeps its reason.')], 'Cancel run', async () => {
        const mine = rv;
        await request(`/api/network/pipeline-runs/${mine.runId}/cancel`, { method: 'POST', body: {} });
        host.closeDialog(); say('Cancelled the run. Its open steps and jobs were cancelled.');
        if (rv === mine) { await refreshRun().catch(() => {}); rHeading.focus(); }
      }, { danger: true });
    }
    /** A job: the Activity drill-down when the page has one (host.openJob), otherwise its record as JSON. */
    async function openJob(jobId) {
      if (host.openJob) { host.openJob(jobId); return; }
      host.openDialog(`Job ${jobId}`, [note('Loading the job…')]);
      try {
        const data = await request(`/api/network/jobs/${jobId}`);
        const pre = el('pre', 'network-preview-text network-job-json', JSON.stringify(data, null, 2)); pre.id = 'network-job-json'; pre.tabIndex = 0; pre.setAttribute('aria-label', 'The job record as JSON');
        host.openDialog(`Job ${jobId}`, [note('The job record as the job engine keeps it, with its accepted request. Results are referenced by file and SHA-256.'), pre, closeActions()]);
      } catch (failure) { host.openDialog(`Job ${jobId}`, [el('p', 'inline-error', failure.message), closeActions()]); }
    }
    // Run canvas: top-level steps at their published positions; an expanded sub-pipeline holds its steps in columns.
    function drawRunCanvas() {
      if (!rv?.run || !window.cytoscape || isPhone() || runView.hidden || panel.hidden) return;
      if (canvases.r.cy && canvases.r.key === rv.runId) { fitSize('r'); return; }
      const cy = makeCanvas('r', rv.runId, true);
      cy.on('tap', 'node', event => selectRun(event.target.id()));
      cy.on('tap', event => { if (event.target === cy) selectRun(null); });
      cy.on('dbltap', 'node', event => { if (group(event.target.id())) toggleGroup(event.target.id()); });
      syncRun(true);
      fitView(cy);
    }
    /** The steps and groups directly inside `parent` (null: the top level), and the arrows between them. */
    const insideOf = parent => [...rv.plan.groups.filter(g => g.parent === parent).map(g => g.id), ...rv.plan.nodes.filter(node => node.group === parent).map(node => node.id)];
    function linksOf(parent) {
      const depth = parent ? chain(parent).length + 1 : 0, direct = id => [...chain(id), id][depth];
      const inside = id => !parent || chain(id).includes(parent);
      return rv.plan.nodes.filter(node => inside(node.id)).flatMap(node => node.deps.filter(dep => inside(dep.from)).map(dep => [direct(dep.from), direct(node.id)])).filter(([a, b]) => a !== b);
    }
    /**
     * Positions of what `parent` holds: the top level as published (columns when a position is missing), a group's steps
     * in columns from its own place. An expanded group takes the room its steps need: what lies to its right moves right,
     * and what lies below it in its column moves down, so nothing is drawn on top of it.
     */
    function place(parent, origin, at) {
      const ids = insideOf(parent), columns = layered(ids, linksOf(parent), parent ? { x: origin.x, y: origin.y } : {});
      const base = new Map(ids.map(id => [id, { ...(parent ? columns.get(id) : rv.positions.get(id) || columns.get(id)) }]));
      const room = new Map();
      for (const id of ids) if (group(id) && rv.expanded.has(id)) {
        const inner = new Map(); place(id, { x: 0, y: 0 }, inner);
        const xs = [...inner.values()].map(p => p.x), ys = [...inner.values()].map(p => p.y);
        room.set(id, { width: Math.max(...xs) - Math.min(...xs) + 120, height: Math.max(...ys) - Math.min(...ys) + 120 });
      }
      const moved = new Map(ids.map(id => [id, { ...base.get(id) }]));
      for (const [g, { width, height }] of room) {
        const from = base.get(g);
        for (const id of ids) {
          if (id === g) continue;
          const p = base.get(id);
          if (p.x > from.x + 1) moved.get(id).x += width;
          else if (Math.abs(p.x - from.x) <= 1 && p.y > from.y) moved.get(id).y += height;
        }
      }
      for (const id of ids) { at.set(id, moved.get(id)); if (room.has(id)) place(id, moved.get(id), at); }
    }
    function runPositions() { const at = new Map(); place(null, { x: 0, y: 0 }, at); return at; }
    /** The canvas elements for what is visible now: collapsed groups as one node, expanded ones as boxes around their steps. */
    function syncRun(rebuild) {
      const cy = canvases.r.cy; if (!cy || !rv?.run) return;
      const label = id => { if (group(id)) { const g = group(id); return `${rv.expanded.has(id) ? '▾' : '▸'} ${clip(g.label, 36)} · v${g.version}${rv.expanded.has(id) ? '' : `\n${STEP_STATES[groupStatus(id)][0]}`}`; } return `${MARKS[step(id).type]} ${clip(runStepName(id), 36)}\n${STEP_STATES[rv.run.nodes[id].status][0]}`; };
      const status = id => (group(id) ? groupStatus(id) : rv.run.nodes[id].status);
      if (rebuild) {
        const at = runPositions(), elements = [], visibleGroups = rv.plan.groups.filter(g => chain(g.id).every(p => rv.expanded.has(p))).map(g => g.id);
        for (const id of visibleGroups) elements.push({ group: 'nodes', data: { id, type: 'subnetwork', label: label(id), ...(group(id).parent ? { parent: group(id).parent } : {}) }, position: { ...at.get(id) }, classes: `${rv.expanded.has(id) ? 'group' : ''} s-${status(id)}` });
        for (const node of rv.plan.nodes) if (shown(node.id) === node.id) elements.push({ group: 'nodes', data: { id: node.id, type: node.type, label: label(node.id), ...(node.group ? { parent: node.group } : {}) }, position: { ...at.get(node.id) }, classes: `s-${status(node.id)}` });
        const edges = new Map();
        for (const node of rv.plan.nodes) for (const dep of node.deps) { const a = shown(dep.from), b = shown(node.id); if (a !== b && !edges.has(`${a}>${dep.port}>${b}`)) edges.set(`${a}>${dep.port}>${b}`, { group: 'edges', data: { id: `r:${a}>${dep.port}>${b}`, source: a, target: b, port: dep.port, label: dep.port } }); }
        cy.batch(() => { cy.elements().remove(); cy.add(elements); cy.add([...edges.values()]); if (rv.selected) cy.getElementById(shown(rv.selected)).select(); });
        return;
      }
      cy.batch(() => {
        for (const item of cy.nodes()) {
          const id = item.id(), text = label(id), names = `${group(id) && rv.expanded.has(id) ? 'group ' : ''}s-${status(id)}`;
          if (item.data('label') !== text) item.data('label', text);
          if (item.classes().join(' ') !== names) item.classes(names);
        }
      });
    }

    // Theme and width: canvases take the page's colours and are never drawn on a phone.
    new MutationObserver(() => { for (const slot of Object.values(canvases)) slot.cy?.style(styleSheet()); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', debounce(() => {
      if (!current) return;
      if (isPhone()) { destroyCanvas('d'); destroyCanvas('r'); }
      if (ed && !designer.hidden) renderEditor();
      if (rv && !runView.hidden) renderRun();
    }, 150));

    // ---- Navigation: a dirty draft asks before anything replaces it ("keep editing" brings its address back).
    function guard(next) {
      if (!ed?.dirty || (next?.section === 'pipelines' && next.pipelineId === ed.id)) return true;
      if (window.confirm(`Discard your unsaved changes to “${ed.name}”?`)) { ed.dirty = false; return true; }
      history.replaceState(history.state, '', `#/network/pipelines/${ed.id}`);
      queueMicrotask(() => window.dispatchEvent(new Event('hashchange')));
      return false;
    }
    function show(next) {
      current = next;
      panel.hidden = !next;
      const view = !next ? null : next.runId ? 'run' : next.pipelineId ? 'designer' : 'list';
      listView.hidden = view !== 'list'; designer.hidden = view !== 'designer'; runView.hidden = view !== 'run';
      if (view !== 'designer') { destroyCanvas('d'); ed = null; }
      if (view !== 'run') leaveRun();
      if (!view) return;
      if (view === 'list') { delete panel.dataset.view; void loadList(); renderList(); return; }
      if (view === 'designer') { if (ed?.key === next.pipelineId) renderDesigner(); else void openDesigner(next.pipelineId); return; }
      if (rv?.runId === next.runId) renderRun(); else void openRun(next.runId);
    }
    return { panel, show, guard, isDirty: () => Boolean(ed?.dirty) };
  }
  return { create, helpers: { topo, layered, reaching, ruleOf, ruleDraft, diffOf, marksOf } };
})();
