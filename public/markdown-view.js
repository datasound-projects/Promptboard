'use strict';

// Safe Markdown preview. Builds DOM nodes only: raw HTML is shown as text, links open only http(s)
// addresses or in-document anchors, and images or other external content are never loaded. Mermaid
// flowcharts of the simple kind Project Context writes are drawn locally as SVG; anything else keeps its
// code and shows a local message. Nothing is fetched and no script is evaluated.
window.PromptboardMarkdown = (() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const ANCHOR = /^<a id="([A-Za-z0-9_-]{1,140})"><\/a>\s*$/;
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const safeHref = href => /^https?:\/\/[^\s]+$/i.test(href) || /^#[A-Za-z0-9_-]{1,140}$/.test(href);

  /** Inline spans: code, links, bold, italic and backslash escapes. Everything else is text. */
  function inline(text, parent) {
    const pattern = /(\\[\\`*_[\]<>|#()!-])|(`+)([\s\S]*?[^`])\2(?!`)|\[([^\]\n]{1,500})\]\(([^()\s]{1,4000}|<[^<>\n]{1,4000}>)\)|(\*\*|__)(?=\S)([\s\S]*?\S)\6|(\*|_)(?=\S)([^*_\n]*?\S)\8(?![A-Za-z0-9])/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) parent.append(text.slice(last, match.index));
      if (match[1]) parent.append(match[1].slice(1));
      else if (match[2]) parent.append(el('code', '', match[3].replace(/^ (.*) $/, '$1')));
      else if (match[4]) {
        const href = match[5].replace(/^<|>$/g, '');
        if (safeHref(href)) {
          const link = el('a'); link.href = href;
          if (!href.startsWith('#')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
          inline(match[4], link); parent.append(link);
        } else parent.append(`${match[4]} (${href})`);
      } else if (match[6]) { const strong = el('strong'); inline(match[7], strong); parent.append(strong); }
      else if (match[8]) { const em = el('em'); inline(match[9], em); parent.append(em); }
      last = match.index + match[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }
  /** Single line breaks inside a paragraph stay visible, as the author typed them. */
  function lines(texts, parent) { texts.forEach((text, index) => { if (index) parent.append(el('br')); inline(text, parent); }); return parent; }
  const cells = row => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));

  /** Render Markdown into a fragment. `options.diagram(code)` returns a node for a mermaid fence. */
  function render(markdown, options = {}) {
    const out = document.createDocumentFragment(), source = String(markdown).replace(/\r\n?/g, '\n').split('\n');
    let index = 0, pendingId = null;
    const heading = (level, text) => { const node = el(`h${Math.min(6, level + 1)}`, 'md-heading'); inline(text.replace(/\s+#+\s*$/, ''), node); if (pendingId) { node.id = pendingId; pendingId = null; } return node; };
    const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    while (index < source.length) {
      const line = source[index];
      if (!line.trim()) { index++; continue; }
      const anchor = line.match(ANCHOR);
      if (anchor) { pendingId = anchor[1]; index++; continue; }
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/);
      if (fence) {
        const body = []; index++;
        while (index < source.length) {
          const close = source[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
          if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) { index++; break; }
          body.push(source[index]); index++;
        }
        const code = body.join('\n'), pre = el('pre', 'md-code'), codeNode = el('code', '', code);
        if (fence[2]) pre.dataset.language = fence[2];
        pre.append(codeNode);
        if (fence[2] === 'mermaid' && options.diagram) out.append(options.diagram(code, pre)); else out.append(pre);
        continue;
      }
      const atx = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
      if (atx) { out.append(heading(atx[1].length, atx[2])); index++; continue; }
      if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.append(el('hr')); index++; continue; }
      if (line.includes('|') && index + 1 < source.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(source[index + 1])) {
        const wrap = el('div', 'md-table'), table = el('table'), head = el('thead'), headRow = el('tr');
        for (const cell of cells(line)) { const th = el('th'); inline(cell, th); headRow.append(th); }
        head.append(headRow); table.append(head);
        const tbody = el('tbody'); index += 2;
        while (index < source.length && source[index].includes('|') && source[index].trim()) {
          const tr = el('tr'); for (const cell of cells(source[index])) { const td = el('td'); inline(cell, td); tr.append(td); }
          tbody.append(tr); index++;
        }
        table.append(tbody); wrap.append(table); out.append(wrap); continue;
      }
      if (/^ {0,3}>/.test(line)) {
        const quoted = [];
        while (index < source.length && /^ {0,3}>/.test(source[index])) quoted.push(source[index++].replace(/^ {0,3}> ?/, ''));
        const quote = el('blockquote'); quote.append(render(quoted.join('\n'), options)); out.append(quote); continue;
      }
      if (listItem.test(line)) {
        const root = { depth: -1, node: null, children: [] }, stack = [root];
        while (index < source.length) {
          const match = source[index].match(listItem);
          if (!match) { if (source[index].trim() && /^\s{2,}/.test(source[index]) && stack.length > 1) { stack.at(-1).text.push(source[index].trim()); index++; continue; } break; }
          const depth = match[1].replace(/\t/g, '  ').length, ordered = /\d/.test(match[2]);
          while (stack.length > 1 && stack.at(-1).depth >= depth) stack.pop();
          const item = { depth, ordered, text: [match[3]], children: [] };
          stack.at(-1).children.push(item); stack.push(item); index++;
        }
        const build = items => {
          const list = el(items[0].ordered ? 'ol' : 'ul');
          for (const item of items) { const li = el('li'); lines(item.text, li); if (item.children.length) li.append(build(item.children)); list.append(li); }
          return list;
        };
        out.append(build(root.children)); continue;
      }
      const paragraph = [];
      while (index < source.length && source[index].trim() && !ANCHOR.test(source[index]) && !/^ {0,3}(`{3,}|~{3,}|#{1,6}\s|>)/.test(source[index]) && !(paragraph.length && listItem.test(source[index]))) paragraph.push(source[index++]);
      out.append(lines(paragraph, el('p')));
    }
    return out;
  }

  // ---- Local flowchart preview ----

  const decode = text => text.replace(/#(\d{1,7}|quot|amp|lt|gt);/g, (all, code) => ({ quot: '"', amp: '&', lt: '<', gt: '>' }[code] ?? (Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : all)));
  class DiagramError extends Error { constructor(line, message) { super(`Line ${line}: ${message}`); } }

  /** Parse the flowchart subset: header, subgraph … end, node declarations and arrows with optional labels. */
  function parseFlowchart(code) {
    const rows = code.split('\n'), header = rows[0]?.trim().match(/^(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\s*$/);
    if (!header) throw new DiagramError(1, 'start with “flowchart LR” or “flowchart TD”.');
    const nodes = new Map(), edges = [], groups = [], stack = [];
    const id = '[A-Za-z][A-Za-z0-9_]{0,200}', label = '"([^"\\n]{0,600})"';
    const node = (name, text) => { if (!nodes.has(name)) nodes.set(name, { id: name, label: name, group: stack.at(-1)?.id || null }); const entry = nodes.get(name); if (text !== undefined) entry.label = decode(text); return entry; };
    rows.slice(1).forEach((raw, offset) => {
      const line = raw.trim(), number = offset + 2;
      if (!line || line.startsWith('%%')) return;
      let match;
      if ((match = line.match(new RegExp(`^subgraph\\s+(${id})(?:\\[${label}\\])?$`)))) { const group = { id: match[1], label: decode(match[2] ?? match[1]), members: [] }; groups.push(group); stack.push(group); return; }
      if (line === 'end') { if (!stack.pop()) throw new DiagramError(number, '“end” has no open subgraph.'); return; }
      if ((match = line.match(new RegExp(`^(${id})(?:\\[${label}\\])?$`)))) { const entry = node(match[1], match[2]); if (stack.length && !stack.at(-1).members.includes(entry.id)) { entry.group = stack.at(-1).id; stack.at(-1).members.push(entry.id); } return; }
      if ((match = line.match(new RegExp(`^(${id})(?:\\[${label}\\])?\\s*(-->|-\\.->|==>)\\s*(?:\\|${label}\\||\\|([^|"\\n]{0,600})\\|)?\\s*(${id})(?:\\[${label}\\])?$`)))) {
        node(match[1], match[2]); node(match[6], match[7]);
        edges.push({ from: match[1], to: match[6], label: decode(match[4] ?? match[5] ?? ''), dashed: match[3] === '-.->' });
        return;
      }
      throw new DiagramError(number, 'this statement is not supported by the local preview.');
    });
    if (stack.length) throw new DiagramError(rows.length, 'a subgraph is missing its “end”.');
    if (!nodes.size) throw new DiagramError(1, 'the diagram has no nodes.');
    return { direction: header[1], nodes: [...nodes.values()], edges, groups };
  }

  /** Layered layout from the recorded edges (cycles are kept, back edges just point backwards). */
  function layout(graph) {
    const out = new Map(graph.nodes.map(node => [node.id, []])), rank = new Map(), state = new Map();
    for (const edge of graph.edges) out.get(edge.from).push(edge.to);
    const visit = id => {
      if (state.get(id) === 2) return rank.get(id);
      if (state.get(id) === 1) return null; // a back edge in a cycle
      state.set(id, 1); let best = 0;
      for (const target of out.get(id)) { const value = visit(target); if (value !== null) best = Math.max(best, value + 1); }
      state.set(id, 2); rank.set(id, best); return best;
    };
    graph.nodes.forEach(node => visit(node.id));
    const max = Math.max(...rank.values()), columns = [];
    for (const node of graph.nodes) { const level = max - rank.get(node.id); (columns[level] ||= []).push(node); }
    const W = 190, H = 54, GX = 90, GY = 34, horizontal = ['LR', 'RL'].includes(graph.direction);
    columns.forEach((column, level) => column.forEach((node, place) => {
      const along = level * ((horizontal ? W : H) + GX), across = place * ((horizontal ? H : W) + GY);
      Object.assign(node, horizontal ? { x: along + 20, y: across + 36, w: W, h: H } : { x: across + 20, y: along + 36, w: W, h: H });
    }));
    if (graph.direction === 'RL' || graph.direction === 'BT') {
      const key = graph.direction === 'RL' ? 'x' : 'y', far = Math.max(...graph.nodes.map(node => node[key]));
      for (const node of graph.nodes) node[key] = far - node[key] + (key === 'x' ? 20 : 36);
    }
    return { width: Math.max(...graph.nodes.map(node => node.x + node.w)) + 30, height: Math.max(...graph.nodes.map(node => node.y + node.h)) + 30 };
  }

  function svg(tag, attributes = {}, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  function drawFlowchart(code) {
    const graph = parseFlowchart(code), size = layout(graph), byId = new Map(graph.nodes.map(node => [node.id, node]));
    const root = svg('svg', { viewBox: `0 0 ${size.width} ${size.height}`, width: size.width, height: size.height, class: 'md-diagram-svg', role: 'img', 'aria-label': `Diagram with ${graph.nodes.length} nodes and ${graph.edges.length} connections` });
    const marker = svg('marker', { id: `md-arrow-${Math.random().toString(36).slice(2)}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M0 0 L10 5 L0 10 z', class: 'md-diagram-arrow' }));
    const defs = svg('defs'); defs.append(marker); root.append(defs);
    for (const group of graph.groups) {
      const members = group.members.map(id => byId.get(id)).filter(Boolean);
      if (!members.length) continue;
      const x = Math.min(...members.map(node => node.x)) - 10, y = Math.min(...members.map(node => node.y)) - 26;
      const box = svg('g', { class: 'md-diagram-group' });
      box.append(svg('rect', { x, y, width: Math.max(...members.map(node => node.x + node.w)) + 10 - x, height: Math.max(...members.map(node => node.y + node.h)) + 10 - y, rx: 10 }),
        svg('text', { x: x + 10, y: y + 16 }, clip(group.label, 40)));
      root.append(box);
    }
    for (const edge of graph.edges) {
      const a = byId.get(edge.from), b = byId.get(edge.to);
      const from = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, to = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const border = (node, toward) => {
        const dx = toward.x - (node.x + node.w / 2), dy = toward.y - (node.y + node.h / 2);
        const scale = Math.min(Math.abs(dx) > 0 ? node.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? node.h / 2 / Math.abs(dy) : Infinity);
        return Number.isFinite(scale) ? { x: node.x + node.w / 2 + dx * scale, y: node.y + node.h / 2 + dy * scale } : { x: node.x + node.w / 2, y: node.y + node.h / 2 };
      };
      const start = border(a, to), end = border(b, from);
      const line = svg('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: `md-diagram-edge${edge.dashed ? ' dashed' : ''}`, 'marker-end': `url(#${marker.id})` });
      line.append(svg('title', {}, `${a.label} → ${b.label}${edge.label ? `: ${edge.label}` : ''}`));
      root.append(line);
      if (edge.label) {
        const text = svg('text', { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 5, class: 'md-diagram-edge-label', 'text-anchor': 'middle' }, clip(edge.label, 36));
        root.append(text);
      }
    }
    for (const node of graph.nodes) {
      const group = svg('g', { class: 'md-diagram-node' });
      group.append(svg('title', {}, node.label), svg('rect', { x: node.x, y: node.y, width: node.w, height: node.h, rx: 9 }),
        svg('text', { x: node.x + node.w / 2, y: node.y + node.h / 2 + 4, 'text-anchor': 'middle' }, clip(node.label, 26)));
      root.append(group);
    }
    return root;
  }

  /** A diagram figure: the local drawing (or a local error), with the exact code one click away. */
  function diagram(code, pre) {
    const figure = el('figure', 'md-diagram');
    try { const drawing = el('div', 'md-diagram-canvas'); drawing.append(drawFlowchart(code)); figure.append(drawing); }
    catch (error) { figure.append(el('p', 'md-diagram-error', `Diagram preview unavailable. ${error instanceof DiagramError ? error.message : 'The diagram could not be drawn.'} The text is unchanged.`)); }
    const details = el('details', 'md-diagram-code'); details.append(el('summary', '', 'Diagram code'), pre);
    figure.append(details);
    return figure;
  }

  return { render: (markdown, options = {}) => render(markdown, { diagram, ...options }), parseFlowchart, drawFlowchart };
})();
