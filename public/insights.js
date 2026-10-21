'use strict';

// Insights: one dialog from the top bar for a Kanban project. It shows what the board already records: rework rounds,
// time in each column, tokens and the reported price per merged card, and the cards whose review or tests failed most.
// Opening it reads one route (GET /api/projects/:id/insights); nothing here starts an agent or asks a model.
window.PromptboardInsights = (() => {
  const { el, button, plural } = window.PromptboardDom;
  const RANGES = [['30', 'Last 30 days'], ['90', '90 days'], ['all', 'All']];
  const GROUPS = [['agents', 'Agent'], ['models', 'Model'], ['templates', 'Template']];
  const TOP = 10;
  const tokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const span = ms => (ms < 60000 ? 'under 1 min' : ms < 3600000 ? `${Math.round(ms / 60000)} min` : ms < 172800000 ? `${(ms / 3600000).toFixed(ms < 36000000 ? 1 : 0)} h` : `${Math.round(ms / 86400000)} days`);
  const share = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
  const money = usd => `$${usd.toFixed(2)}`;
  const cardName = row => `${row.number === null ? '' : `#${row.number} `}${row.title}`;

  /** A thin bar for `fraction` (0–1); the numbers beside it carry the meaning, so the bar is hidden from screen readers. */
  function bar(fraction) {
    const track = el('span', 'insights-bar'), fill = el('span');
    track.setAttribute('aria-hidden', 'true'); fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    track.append(fill);
    return track;
  }
  const row = (label, fraction, ...values) => { const node = el('li', 'insights-row'); node.append(label, bar(fraction), el('span', 'insights-value')); node.lastChild.append(...values); return node; };
  const list = rows => { const node = el('ul', 'insights-list'); node.append(...rows); return node; };
  const section = (title, ...nodes) => { const node = el('section', 'insights-section'); node.append(el('h3', '', title), ...nodes); return node; };
  const note = text => el('p', 'note', text);

  function create({ api, projects, currentProject, ensureBoard, openTask }) {
    const opener = document.getElementById('insights-open');
    if (!opener) return;
    const dialog = el('dialog', 'kanban-dialog insights-dialog');
    dialog.id = 'insights-dialog'; dialog.setAttribute('aria-labelledby', 'insights-heading');
    const close = button('×', () => dialog.close(), 'dialog-close icon-button'); close.setAttribute('aria-label', 'Close insights');
    const eyebrow = el('p', 'eyebrow', 'INSIGHTS'), heading = el('h2', '', 'Insights'); heading.id = 'insights-heading';
    const picker = el('select'); picker.id = 'insights-project';
    const pickerLabel = el('label', 'field-label insights-project', 'Project'); pickerLabel.append(picker);
    const ranges = el('div', 'view-switch insights-range'); ranges.setAttribute('role', 'group'); ranges.setAttribute('aria-label', 'Time range');
    const controls = el('div', 'insights-controls'); controls.append(pickerLabel, ranges);
    const status = el('p', 'insights-status'); status.setAttribute('role', 'status');
    const error = el('p', 'inline-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const body = el('div', 'insights-body');
    dialog.append(close, eyebrow, heading, controls, status, error, body,
      note('Counted from the board’s own records: no model is asked. Prices are Claude Code’s own estimates, not a bill.'));
    document.body.append(dialog);
    let range = '30', group = 'agents', projectId = null, data = null, ticket = 0;

    for (const [value, label] of RANGES) ranges.append(button(label, () => { range = value; void load(); }, ''));
    const syncRanges = () => [...ranges.children].forEach((node, index) => node.setAttribute('aria-pressed', String(RANGES[index][0] === range)));
    picker.addEventListener('change', () => { projectId = picker.value; void load(); });

    async function load() {
      syncRanges();
      const id = projectId, mine = ++ticket;
      eyebrow.textContent = (projects().find(project => project.id === id)?.name || 'Insights').toUpperCase();
      status.textContent = 'Counting…'; error.hidden = true;
      try {
        const { response, data: answer } = await api(`/api/projects/${encodeURIComponent(id)}/insights?days=${range}`, { timeoutMs: 30000 });
        if (mine !== ticket) return;
        if (!response.ok) throw new Error(answer.error || 'Insights could not be read. Try again.');
        data = answer.insights; render();
        status.textContent = `Updated ${new Date(data.now).toLocaleTimeString()}`;
      } catch (failure) {
        if (mine !== ticket) return;
        status.textContent = ''; error.textContent = failure.message; error.hidden = false;
      }
    }

    function render() {
      const when = data.days ? `in the last ${data.days} days` : 'yet';
      const { summary } = data;
      const nodes = [];
      if (!summary.finished) nodes.push(note(`No finished cards ${when}.`), columns(when), failing(when));
      else nodes.push(tiles(summary), rework(), columns(when), cost(when), failing(when));
      if (data.runsCapped) nodes.push(note('Based on the newest 5,000 agent runs of this project.'));
      body.replaceChildren(...nodes);
    }

    function tiles(summary) {
      const tile = (value, label, detail = '', title = '') => { const node = el('div', 'insights-tile'); node.append(el('strong', '', value), el('span', '', label)); if (detail) node.append(el('small', '', detail)); if (title) node.title = title; return node; };
      const node = el('div', 'insights-tiles');
      node.append(tile(String(summary.finished), 'cards finished'), tile(String(summary.merged), 'merged'),
        tile(summary.medianToMergeMs === null ? '—' : span(summary.medianToMergeMs), 'median from first start to merge', '', summary.medianToMergeMs === null ? 'No merged card has a recorded agent start.' : ''),
        tile(tokens(summary.tokens), 'tokens', `${tokens(summary.cachedTokens)} cached`));
      if (summary.priceUSD !== null) node.append(tile(money(summary.priceUSD), 'reported price', `for ${summary.pricedCards} of ${plural(summary.finished, 'card')}`));
      return node;
    }

    function rework() {
      const switcher = el('div', 'view-switch insights-group'); switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', 'Group rework by');
      const holder = el('div');
      const show = () => {
        [...switcher.children].forEach((node, index) => node.setAttribute('aria-pressed', String(GROUPS[index][0] === group)));
        const rows = data.rework[group];
        holder.replaceChildren(rows.length ? list(rows.map(item => row(el('span', 'insights-label', item.label), item.cards ? item.reworked / item.cards : 0,
          el('strong', '', `${share(item.reworked, item.cards)}% reworked`), ` · ${(item.rounds / item.cards).toFixed(1)} rounds per card · ${plural(item.cards, 'card')}`)))
          : note('No agent worked on these cards.'));
      };
      for (const [value, label] of GROUPS) switcher.append(button(label, () => { group = value; show(); }, ''));
      show();
      return section('Rework', note('How many finished cards went back at least once because the review asked for changes or tests failed.'), switcher, holder);
    }

    function columns(when) {
      const rows = data.columns, longest = Math.max(...rows.map(item => item.totalMs), 0);
      if (!rows.some(item => item.stays)) return section('Time in each column', note(`No cards moved ${when}.`));
      return section('Time in each column', note('Median and total time per stay. Cards still in a column count up to now.'),
        list(rows.map(item => row(el('span', 'insights-label', item.title), longest ? item.totalMs / longest : 0,
          ...(item.stays ? [`median ${span(item.medianMs)} · total ${span(item.totalMs)}`] : ['No cards']),
          ...(item.open ? [el('span', 'insights-open', `${item.open} still here`)] : [])))));
    }

    const cardButton = item => button(cardName(item), () => { dialog.close(); openTask(projectId, item.id); }, 'text-button insights-card', `Open the details of ${cardName(item)}`);

    function cost(when) {
      const cards = data.cost.cards;
      if (!cards.length) return section('Cost per merged card', note(`No merged cards ${when}.`));
      const most = cards[0].tokens;
      const price = item => {
        if (item.usd !== null) return el('span', '', money(item.usd));
        const unknown = el('span', 'insights-unknown', '—'); unknown.title = item.priceNote; unknown.setAttribute('aria-label', `Price unknown. ${item.priceNote}`); unknown.tabIndex = 0;
        return unknown;
      };
      const rows = cards.map(item => row(cardButton(item), most ? item.tokens / most : 0, `${tokens(item.tokens)} tokens · ${tokens(item.cachedTokens)} cached · `, price(item)));
      const nodes = [note(`Median ${tokens(data.cost.medianTokens)} tokens per merged card. Input and output count; cached input is shown on its own.`), list(rows.slice(0, TOP))];
      if (rows.length > TOP) { const more = el('details', 'insights-more'); more.append(el('summary', '', `More (${rows.length - TOP})`), list(rows.slice(TOP))); nodes.push(more); }
      return section('Cost per merged card', ...nodes);
    }

    function failing(when) {
      const { cards, templates } = data.failing;
      if (!cards.length) return section('Cards that fail review most', note(`No review or test failures ${when}.`));
      const most = cards[0].total;
      const rows = cards.map(item => {
        const from = [item.review && `${item.review} from review`, item.tests && `${item.tests} from tests`].filter(Boolean).join(', ');
        const node = row(cardButton(item), item.total / most, el('strong', '', plural(item.total, 'round')), ` · ${from}`);
        // The template is named only when the cards have more than one, as the grouping below shows.
        const reason = [item.reason, templates.length ? item.template : ''].filter(Boolean).join(' · ');
        if (reason) node.append(el('span', 'insights-reason', reason));
        return node;
      });
      const nodes = [list(rows)];
      if (templates.length) nodes.push(el('h4', '', 'By template'), list(templates.map(item => row(el('span', 'insights-label', item.label), item.rounds / templates[0].rounds, `${plural(item.rounds, 'round')} on ${plural(item.cards, 'card')}`))));
      return section('Cards that fail review most', ...nodes);
    }

    async function open() {
      if (!projects().length) await ensureBoard?.();
      const all = projects();
      projectId = all.some(project => project.id === projectId) ? projectId : currentProject()?.id || all[0]?.id || null;
      picker.replaceChildren(...all.map(project => { const option = el('option', '', project.name); option.value = project.id; return option; }));
      picker.value = projectId || '';
      pickerLabel.hidden = all.length < 2;
      body.replaceChildren(); error.hidden = true;
      if (!dialog.open) dialog.showModal();
      if (!projectId) { syncRanges(); status.textContent = 'Create a project on the Kanban page first.'; return; }
      await load();
    }
    opener.addEventListener('click', () => { projectId = currentProject()?.id || projectId; void open(); });
    dialog.addEventListener('close', () => { if (document.activeElement === document.body || dialog.contains(document.activeElement)) opener.focus(); });
  }

  return { create };
})();
