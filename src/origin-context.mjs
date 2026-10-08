/**
 * Project Context: one Markdown document generated from a saved Origin blueprint revision and then
 * edited on its own. Conversion is one-way: the document never writes Origin, and Origin changes reach
 * it only when the person regenerates. Nothing here calls a model, fetches a source, scans a repository
 * or starts an agent.
 *
 * Files live in <dataDir>/origin/context/<project>/: document.json (metadata; replacing it is the commit
 * point) and immutable, content-addressed Markdown files (<sha256>.md). An interrupted write therefore
 * leaves either the previous document or the new one, never text that disagrees with its metadata.
 */
import '../public/origin-model.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redactLocal } from './compose-local.mjs';
import { ORIGIN_DIR, OriginError, escapeId } from './origin.mjs';

const Model = globalThis.PromptboardOriginModel;
export const FORMAT_VERSION = 1;
export const DOCUMENT_BYTES = 8 * 1024 * 1024; // The master file; destinations apply their own, smaller limits.
const VERSION_LIMIT = 20; // ponytail: oldest unused versions are pruned; raise if people need longer history.
const SCHEMA = 'promptboard.origin-context';
const sha256 = text => createHash('sha256').update(text).digest('hex');

// ---- Exporter ----

/** Every stored field per record. A field missing here is listed as unsupported instead of being lost. */
export const FIELDS = {
  requirements: ['key', 'title', 'description', 'type', 'priority', 'status', 'acceptanceCriteria', 'componentIds', 'sourceIds'],
  components: ['name', 'type', 'purpose', 'responsibilities', 'technologyIds', 'interfaces', 'dataHandled', 'status', 'notes', 'sourceIds', 'x', 'y', 'layerId', 'answers'],
  connections: ['from', 'to', 'label', 'protocol', 'notes'],
  technologies: ['name', 'category', 'purpose', 'version', 'status', 'reason', 'alternatives', 'sourceIds'],
  dependencies: ['name', 'type', 'version', 'requiredBy', 'dependsOn', 'sourceIds', 'notes'],
  decisions: ['key', 'title', 'context', 'decision', 'alternatives', 'reason', 'consequences', 'status', 'date', 'supersededBy', 'componentIds', 'technologyIds', 'requirementIds', 'dependencyIds', 'sourceIds'],
  assumptions: ['statement', 'reason', 'impact', 'status', 'decisionId', 'sourceIds'],
  sources: ['title', 'url', 'type', 'claim', 'accessedAt', 'verification', 'notes'],
  risks: ['title', 'description', 'kind', 'severity', 'mitigation', 'status', 'componentIds'],
  areas: ['section', 'area', 'title', 'description', 'status', 'componentIds', 'requirementIds', 'technologyIds', 'baseResourceIds'],
  milestones: ['title', 'goal', 'definitionOfDone'],
  items: ['key', 'milestoneId', 'workstream', 'title', 'description', 'acceptanceCriteria', 'dependsOn', 'requirementIds', 'componentIds', 'layerId', 'contextIds', 'status', 'handoff', 'refinement', 'lostLinks'],
  layers: ['name', 'description', 'technologyIds', 'constraints'],
  customSections: ['phase', 'title', 'description', 'notApplicable'],
  questions: ['scope', 'sectionId', 'text'],
};
// `sequence` only reserves the next display key; it is application bookkeeping, not design content.
export const TOP_FIELDS = ['idea', 'vision', 'sections', 'labels', 'answers', 'questionText', 'layout', 'sequence', ...Object.keys(FIELDS)];

const NOT_PROVIDED = '_Not provided._';
// Lines that would change the document's own structure (fences, headings, setext underlines, raw HTML)
// make a field render as a fenced block, exactly as written.
const UNSAFE = /^ {0,3}(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|<|[=-]{2,}[ \t]*$)/m;
const escapeInline = text => text.replace(/[\\`*_[\]<>|]/g, '\\$&');
const iso = value => (Number.isSafeInteger(value) && value > 0 ? new Date(value).toISOString() : '');

function fence(text, info = 'text') {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}${info}\n${text}\n${marks}`;
}
/** Safe node IDs for Mermaid: a prefix plus the record ID with "_" and "-" escaped, so IDs never collide. */
const nodeId = (prefix, id) => `${prefix}_${id.replace(/_/g, '__').replace(/-/g, '_h')}`;
/** Mermaid label text: one line, with anything outside a small safe set written as an entity code. */
const mermaidText = text => String(text || '').replace(/\s+/g, ' ').trim().replace(/[^\p{L}\p{N} .,!?'()/+=@-]/gu, ch => `#${ch.codePointAt(0)};`);

function exporter(record) {
  const bp = record.blueprint, redactions = [], unsupported = [];
  const clean = (value, where) => {
    const text = String(value ?? '').replace(/\r\n?/g, '\n');
    const safe = redactLocal(text);
    if (safe !== text) redactions.push(where);
    return safe;
  };
  const inline = (value, where, fallback = '') => { const text = escapeInline(clean(value, where).replace(/\s+/g, ' ').trim()); return text || fallback; };
  const block = (value, where) => {
    const text = clean(value, where).replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!text.trim()) return '';
    return UNSAFE.test(text) ? fence(text) : text;
  };
  const listOf = (value, where) => {
    const text = clean(value, where).replace(/\s+$/, '');
    if (!text.trim()) return '';
    if (UNSAFE.test(text)) return fence(text);
    return text.split('\n').filter(line => line.trim()).map(line => `- ${line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()}`).join('\n');
  };
  const maps = Object.fromEntries(Object.keys(FIELDS).map(name => [name, new Map((bp[name] || []).map(entry => [entry.id, entry]))]));
  const display = (collection, entry) => {
    const name = entry.name || entry.title || entry.statement || '';
    return `${entry.key ? `${entry.key} ` : ''}${name.replace(/\s+/g, ' ').trim() || 'Untitled'}`;
  };
  const ref = (collection, id) => {
    const entry = maps[collection]?.get(id);
    return entry ? `${inline(display(collection, entry), `${collection} ${id} name`)} (\`${id}\`)` : `\`${id}\` (missing record — the reference could not be resolved)`;
  };
  const refs = (collection, ids) => (ids || []).map(id => ref(collection, id)).join('; ');
  const sectionTitle = id => Model.sectionTitle(bp, id);
  const sources = maps.sources;

  // One record: scalar facts as a list, then each written field under its own label, then one compact
  // line naming the fields that are empty.
  function recordBlock(collection, entry, heading, facts, fields) {
    const where = `${collection} ${entry.id}`;
    const out = [`#### ${inline(heading, `${where} title`, 'Untitled')}`, ''];
    const factLines = [['Record ID', `\`${entry.id}\``], ...facts, ['Entered by', Model.label('origin', entry.origin)]].filter(([, value]) => value !== undefined && value !== '');
    out.push(...factLines.map(([name, value]) => `- **${name}:** ${value}`), '');
    const empty = [];
    for (const [name, value, kind = 'block'] of fields) {
      const text = kind === 'list' ? listOf(value, `${where} ${name}`) : block(value, `${where} ${name}`);
      if (!text) { empty.push(name); continue; }
      out.push(`**${name}**`, '', text, '');
    }
    if (empty.length) out.push(`_Not provided: ${empty.join(', ')}._`, '');
    for (const key of Object.keys(entry)) if (!['id', 'origin', ...FIELDS[collection]].includes(key)) unsupported.push({ path: `${collection}.${entry.id}.${key}`, value: entry[key] });
    return out.join('\n');
  }
  const evidence = entry => (entry.sourceIds?.length ? `${refs('sources', entry.sourceIds)} — ${Model.VERIFICATION_LABELS[Model.verification(entry, sources)]}` : '');
  const enumLabel = (name, value) => Model.label(name, value);
  const questionsFor = (sectionId, answers) => bp.questions.filter(question => question.scope === 'section' && question.sectionId === sectionId)
    .map(question => `**${inline(question.text, `question ${question.id}`, 'Untitled question')}** (\`${question.id}\`)\n\n${block(answers[question.id], `answer ${question.id}`) || NOT_PROVIDED}`);

  const states = Model.sectionStates(bp);
  const SECTION = {
    overview() {
      const out = ['- **Project name:** ' + inline(record.name, 'project name', 'Untitled'), `- **Origin project ID:** \`${record.id}\``,
        `- **Linked Kanban project:** ${record.kanbanProjectId ? `\`${record.kanbanProjectId}\`` : 'none'}`, ''];
      for (const [name, value] of [['Project description', record.description], ['Idea', bp.idea]]) out.push(`**${name}**`, '', block(value, name.toLowerCase()) || NOT_PROVIDED, '');
      const ready = Model.readiness(bp);
      out.push(`**Readiness when exported** (derived by Origin from the records below): ${ready.label}`, '', ...ready.reasons.map(reason => `- ${escapeInline(reason)}`), '');
      const found = Model.issues(bp);
      if (found.length) out.push('**Open points detected by Origin**', '', ...found.map(issue => `- ${escapeInline(issue.title)}${issue.blocking ? ' (blocking)' : ''}`), '');
      out.push('**Overview hierarchy**', '', 'The Overview map branches from the project to each section, grouped by phase:', '', `- ${inline(record.name, 'project name', 'Project')}`);
      for (const phase of Model.phaseList(bp)) {
        out.push(`  - ${inline(phase.label, `phase ${phase.id} label`)}`);
        for (const id of phase.sections.filter(id => id !== 'overview')) out.push(`    - ${inline(sectionTitle(id), `section ${id} title`)} (\`${id}\`)`);
      }
      const nodeName = key => (key === 'center' ? `${inline(record.name, 'project name', 'Project')} (project)` : `${inline(sectionTitle(key), `section ${key} title`)} (\`${key}\`)`);
      const links = bp.layout.map.links;
      out.push('', '**Visual links drawn on the Overview map**', '', 'These are visual relationships only. They are not architecture dependencies or task prerequisites.', '');
      if (links.length) out.push('| From | To | Label | Link ID |', '| --- | --- | --- | --- |', ...links.map(link => `| ${nodeName(link.from)} | ${nodeName(link.to)} | ${inline(link.label, `map link ${link.id}`) || '—'} | \`${link.id}\` |`));
      else out.push(NOT_PROVIDED);
      return out;
    },
    vision() {
      return Model.VISION.filter(key => key !== 'architectureSummary' || bp.vision[key].trim()).map(key => {
        const list = ['users', 'useCases', 'inScope', 'outOfScope', 'successCriteria'].includes(key);
        const text = list ? listOf(bp.vision[key], `vision ${key}`) : block(bp.vision[key], `vision ${key}`);
        return `**${inline(Model.questionText(bp, `vision:${key}`, Model.VISION_QUESTIONS[key]), `vision ${key} wording`)}** (\`vision.${key}\`)\n\n${text || NOT_PROVIDED}\n`;
      });
    },
    requirements: () => bp.requirements.map(item => recordBlock('requirements', item, display('requirements', item), [
      ['Priority', enumLabel('priority', item.priority)], ['Type', enumLabel('requirementType', item.type)], ['Status', enumLabel('itemStatus', item.status)],
      ['Built by', refs('components', item.componentIds)], ['Evidence', evidence(item)]], [['Description', item.description], ['Done when', item.acceptanceCriteria, 'list']])),
    architecture() {
      const out = [], layerOf = id => maps.layers.get(id);
      out.push('#### Layers', '');
      if (!bp.layers.length) out.push(NOT_PROVIDED, '');
      for (const layer of bp.layers) out.push(recordBlock('layers', layer, layer.name || 'Unnamed layer', [
        ['Stack', layer.technologyIds.map(id => `${ref('technologies', id)} — ${enumLabel('techStatus', maps.technologies.get(id)?.status)}`).join('; ')],
        ['Components in this layer', refs('components', bp.components.filter(component => component.layerId === layer.id).map(component => component.id))]],
        [['What belongs here', layer.description], ['Shared rules', layer.constraints]]).replace(/^####/, '#####'));
      out.push('#### Components', '');
      if (!bp.components.length) out.push(NOT_PROVIDED, '');
      const componentQuestions = bp.questions.filter(question => question.scope === 'component');
      for (const component of bp.components) {
        const word = key => Model.questionText(bp, `field:components:${key}`, Model.COMPONENT_FIELDS[key]);
        let text = recordBlock('components', component, component.name || 'Unnamed component', [
          ['Type', enumLabel('componentType', component.type)], ['Layer', component.layerId ? ref('layers', component.layerId) : 'none'], ['Status', enumLabel('itemStatus', component.status)],
          ['Technologies', refs('technologies', component.technologyIds)], ['Evidence', evidence(component)],
          ['Connects to', bp.connections.filter(row => row.from === component.id).map(row => ref('components', row.to)).join('; ')],
          ['Connected from', bp.connections.filter(row => row.to === component.id).map(row => ref('components', row.from)).join('; ')]],
          [[inline(word('purpose'), 'component wording'), component.purpose], [inline(word('responsibilities'), 'component wording'), component.responsibilities, 'list'],
            [inline(word('interfaces'), 'component wording'), component.interfaces], [inline(word('dataHandled'), 'component wording'), component.dataHandled], ['Notes', component.notes]]).replace(/^####/, '#####');
        if (componentQuestions.length) text += '\n' + componentQuestions.map(question => `**${inline(question.text, `question ${question.id}`, 'Untitled question')}** (\`${question.id}\`)\n\n${block(component.answers?.[question.id], `components ${component.id} answer ${question.id}`) || NOT_PROVIDED}`).join('\n\n') + '\n';
        out.push(text);
      }
      out.push('#### Connections', '');
      if (bp.connections.length) {
        out.push('Each row is directed: the first component connects to the second.', '', '| From | To | Label | Protocol | Connection ID |', '| --- | --- | --- | --- | --- |',
          ...bp.connections.map(row => `| ${ref('components', row.from)} | ${ref('components', row.to)} | ${inline(row.label, `connections ${row.id} label`) || '—'} | ${inline(row.protocol, `connections ${row.id} protocol`) || '—'} | \`${row.id}\` |`), '');
        for (const row of bp.connections.filter(row => row.notes.trim())) out.push(`**Notes on \`${row.id}\`**`, '', block(row.notes, `connections ${row.id} notes`), '');
        for (const row of bp.connections) for (const key of Object.keys(row)) if (!['id', 'origin', ...FIELDS.connections].includes(key)) unsupported.push({ path: `connections.${row.id}.${key}`, value: row[key] });
      } else out.push(NOT_PROVIDED, '');
      out.push('#### Architecture diagram', '');
      if (!bp.components.length) out.push(NOT_PROVIDED);
      else {
        const lines = ['flowchart LR'];
        const node = component => `${nodeId('C', component.id)}["${mermaidText(component.name) || mermaidText(component.id)}"]`;
        for (const layer of bp.layers) {
          const members = bp.components.filter(component => component.layerId === layer.id);
          if (!members.length) continue;
          lines.push(`  subgraph ${nodeId('L', layer.id)}["${mermaidText(layer.name) || mermaidText(layer.id)}"]`, ...members.map(component => `    ${node(component)}`), '  end');
        }
        lines.push(...bp.components.filter(component => !layerOf(component.layerId)).map(component => `  ${node(component)}`));
        for (const row of bp.connections) {
          const text = mermaidText([row.label, row.protocol].filter(value => value.trim()).join(' · '));
          lines.push(`  ${nodeId('C', row.from)} -->${text ? `|"${text}"|` : ''} ${nodeId('C', row.to)}`);
        }
        out.push('The diagram is generated from the saved components, layers and connections; the tables above are its plain-text equivalent.', '', fence(lines.join('\n'), 'mermaid'), '',
          '**Diagram nodes**', '', '| Diagram node | Component | Layer | Type |', '| --- | --- | --- | --- |',
          ...bp.components.map(component => `| \`${nodeId('C', component.id)}\` | ${ref('components', component.id)} | ${component.layerId ? ref('layers', component.layerId) : '—'} | ${enumLabel('componentType', component.type)} |`));
      }
      return out;
    },
    technology() {
      const out = [];
      for (const [status, title] of [['selected', 'Selected'], ['candidate', 'Candidates (not decided)'], ['rejected', 'Rejected']]) {
        const rows = bp.technologies.filter(item => item.status === status);
        out.push(`#### ${title}`, '', ...(rows.length ? rows.map(item => recordBlock('technologies', item, item.name || 'Unnamed technology', [
          ['Status', enumLabel('techStatus', item.status)], ['Category', enumLabel('techCategory', item.category)], ['Version', inline(item.version, `technologies ${item.id} version`)],
          ['Evidence', evidence(item)], ['Used by', refs('components', bp.components.filter(component => component.technologyIds.includes(item.id)).map(component => component.id))]],
          [['Why this one?', item.reason], ['Purpose', item.purpose], ['Alternatives considered', item.alternatives, 'list']]).replace(/^####/, '#####')) : [NOT_PROVIDED, '']));
      }
      return out;
    },
    dependencies: () => bp.dependencies.map(item => recordBlock('dependencies', item, item.name || 'Unnamed dependency', [
      ['Type', enumLabel('dependencyType', item.type)], ['Version', inline(item.version, `dependencies ${item.id} version`)], ['Needed by', refs('components', item.requiredBy)],
      ['Depends on', refs('dependencies', item.dependsOn)], ['Evidence', evidence(item)]], [['Notes', item.notes]])),
    research() {
      const out = ['#### Sources', ''];
      if (!bp.sources.length) out.push(NOT_PROVIDED, '');
      const cited = id => Object.keys(FIELDS).flatMap(collection => (bp[collection] || []).filter(entry => entry.sourceIds?.includes(id)).map(entry => ref(collection, entry.id)));
      for (const item of bp.sources) out.push(recordBlock('sources', item, item.title || item.url || 'Untitled source', [
        ['Link', item.url ? `[${escapeInline(item.url)}](${item.url.replace(/[()\s<>]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})` : ''], ['Checked?', enumLabel('sourceVerification', item.verification)],
        ['Type', enumLabel('sourceType', item.type)], ['Date checked', item.accessedAt], ['Evidence for', cited(item.id).join('; ')]],
        [['What it supports', item.claim], ['Notes', item.notes]]).replace(/^####/, '#####'));
      out.push('Only the claims stored here are included. Linked pages were not fetched.', '', '#### Assumptions', '');
      if (!bp.assumptions.length) out.push(NOT_PROVIDED, '');
      for (const item of bp.assumptions) out.push(recordBlock('assumptions', item, item.statement || 'Untitled assumption', [
        ['Status', enumLabel('assumptionStatus', item.status)], ['Became decision', item.decisionId ? ref('decisions', item.decisionId) : ''], ['Evidence', evidence(item)]],
        [['If it is wrong…', item.impact], ['Why you assume it', item.reason]]).replace(/^####/, '#####'));
      out.push('#### Risks', '');
      if (!bp.risks.length) out.push(NOT_PROVIDED, '');
      for (const item of bp.risks) out.push(recordBlock('risks', item, item.title || 'Untitled risk', [
        ['Severity', enumLabel('severity', item.severity)], ['Kind', enumLabel('riskKind', item.kind)], ['Status', enumLabel('riskStatus', item.status)], ['Affects', refs('components', item.componentIds)]],
        [['Description', item.description], ['How you reduce it', item.mitigation]]).replace(/^####/, '#####'));
      return out;
    },
    decisions: () => bp.decisions.map(item => recordBlock('decisions', item, display('decisions', item), [
      ['Status', enumLabel('decisionStatus', item.status)], ['Date', item.date], ['Superseded by', item.supersededBy ? ref('decisions', item.supersededBy) : ''],
      ['Applies to components', refs('components', item.componentIds)], ['Technologies', refs('technologies', item.technologyIds)], ['Requirements', refs('requirements', item.requirementIds)],
      ['Dependencies', refs('dependencies', item.dependencyIds)], ['Evidence', evidence(item)]],
      [['Decision', item.decision], ['Why', item.reason], ['Context', item.context], ['Alternatives', item.alternatives, 'list'], ['Consequences', item.consequences]])),
    plan() {
      const out = ['#### Milestones', ''];
      if (!bp.milestones.length) out.push(NOT_PROVIDED, '');
      bp.milestones.forEach((item, index) => out.push(recordBlock('milestones', item, `${index + 1}. ${item.title || 'Untitled milestone'}`, [],
        [['Goal', item.goal], ['Done when', item.definitionOfDone, 'list']]).replace(/^####/, '#####')));
      out.push('#### Tasks', '');
      if (!bp.items.length) out.push(NOT_PROVIDED, '');
      const groups = [...bp.milestones.map(milestone => [milestone.id, milestone.title || 'Untitled milestone']), ['', 'Unscheduled']];
      for (const [milestoneId, title] of groups) {
        const rows = bp.items.filter(item => (maps.milestones.has(item.milestoneId) ? item.milestoneId : '') === milestoneId);
        if (!rows.length) continue;
        out.push(`**Milestone: ${inline(title, 'milestone title')}**`, '');
        for (const item of rows) {
          const home = Model.taskHome(bp, item), refinement = item.refinement, handoff = item.handoff;
          const fields = [['What to do', item.description], ['Done when', item.acceptanceCriteria, 'list']];
          if (refinement?.acceptedAt) {
            fields.push(['Original “What to do” (before the accepted refinement)', refinement.originalDescription]);
            if (refinement.proposal !== item.description) fields.push(['Refinement as accepted from Compose (later edited above)', refinement.proposal]);
          } else if (refinement?.proposal) fields.push(['Pending Compose proposal (not accepted)', refinement.proposal]);
          if (refinement?.basis && ![item.description, refinement.originalDescription].includes(refinement.basis)) fields.push(['Text the Compose proposal was based on', refinement.basis]);
          let text = recordBlock('items', item, display('items', item), [
            ['Status', enumLabel('workStatus', item.status)], ['Workstream', inline(item.workstream, `items ${item.id} workstream`)],
            ['Components', refs('components', item.componentIds)], ['Layer', home.layerId ? ref('layers', home.layerId) : 'whole project'],
            ['Starts after', refs('items', item.dependsOn)], ['Requirements', refs('requirements', item.requirementIds)],
            ['Also include', (item.contextIds || []).map(link => ref(link.collection, link.id)).join('; ')],
            ['Instruction', refinement?.acceptedAt ? `refined in Compose and accepted ${iso(refinement.acceptedAt)}` : refinement?.proposal ? `original; a Compose proposal from ${iso(refinement.proposedAt) || 'an earlier session'} is pending` : ''],
            ['Sent to Kanban', handoff ? `Kanban project \`${handoff.projectId}\`, card \`${handoff.taskId}\` on ${iso(handoff.at)}; context snapshot \`${handoff.snapshotId}\` (hash ${handoff.hash.slice(0, 12)}). The card's current column is not part of this document.` : ''],
            ['Links removed with deleted records', (item.lostLinks || []).map(link => `${escapeInline(link.collection)}: ${inline(link.name, `items ${item.id} lost link`)}`).join('; ')]], fields).replace(/^####/, '#####');
          out.push(text);
        }
      }
      out.push('#### Task prerequisites', '');
      const edges = bp.items.flatMap(item => item.dependsOn.map(before => [before, item.id]));
      if (!edges.length) out.push(NOT_PROVIDED);
      else {
        const used = new Set(edges.flat());
        const lines = ['flowchart TD', ...bp.items.filter(item => used.has(item.id)).map(item => `  ${nodeId('T', item.id)}["${mermaidText(display('items', item))}"]`),
          ...edges.map(([before, after]) => `  ${nodeId('T', before)} --> ${nodeId('T', after)}`)];
        out.push('An arrow means the second task starts after the first one. This graph shows prerequisites only; architecture connections are separate.', '', fence(lines.join('\n'), 'mermaid'), '',
          '| Starts first | Then |', '| --- | --- |', ...edges.map(([before, after]) => `| ${ref('items', before)} | ${ref('items', after)} |`));
      }
      return out;
    },
  };
  const AREA_STATE = { draft: 'In progress', defined: 'Defined', needs_decision: 'Needs decision', assumption: 'Based on an assumption' };
  for (const id of Object.keys(Model.AREAS)) SECTION[id] = () => {
    const out = [], unanswered = [];
    for (const [topic, builtin] of Model.AREAS[id]) {
      const rows = bp.areas.filter(item => item.section === id && item.area === topic);
      const name = `${inline(Model.questionText(bp, `topic:${id}:${topic}`, builtin), `topic ${id} ${topic} wording`)} (\`${topic}\`)`;
      if (!rows.length) { unanswered.push(name); continue; }
      out.push(`#### ${name}`, '');
      for (const item of rows) out.push(recordBlock('areas', item, item.title || 'Untitled answer', [
        ['Status', AREA_STATE[item.status] || item.status], ['Components', refs('components', item.componentIds)], ['Requirements', refs('requirements', item.requirementIds)],
        ['Technologies', refs('technologies', item.technologyIds)], ['Base references', (item.baseResourceIds || []).map(value => `\`${value}\``).join(', ') + (item.baseResourceIds?.length ? ' (Base resource IDs; their contents are not copied)' : '')]],
        [['Details', item.description]]).replace(/^####/, '#####'));
    }
    if (unanswered.length) out.push(`_Topics not provided: ${unanswered.join(', ')}._`, '');
    return out;
  };

  // ---- Assemble in sidebar order ----
  const toc = [], parts = [];
  Model.phaseList(bp).forEach((phase, index) => {
    toc.push(`- [${index + 1}. ${inline(phase.label, `phase ${phase.id} label`)}](#ctx-phase-${phase.id})`);
    parts.push(`<a id="ctx-phase-${phase.id}"></a>`, `## ${index + 1}. ${inline(phase.label, `phase ${phase.id} label`)}`, '');
    for (const id of phase.sections) {
      const custom = bp.customSections.find(entry => entry.id === id), title = inline(sectionTitle(id), `section ${id} title`, 'Untitled section');
      toc.push(`  - [${title}](#ctx-section-${id})`);
      parts.push(`<a id="ctx-section-${id}"></a>`, `### ${title}`, '');
      const builtin = Model.sectionLabel(id), notApplicable = custom ? custom.notApplicable : Boolean(bp.sections[id]?.notApplicable);
      const facts = [`- **Section ID:** \`${id}\`${!custom && sectionTitle(id) !== builtin ? ` (built-in section “${builtin}”)` : ''}`];
      if (!custom) facts.push(`- **Guiding question:** ${inline(Model.questionText(bp, `section:${id}`, Model.QUESTIONS[id]), `section ${id} question`)}`);
      else facts.push(`- **Kind:** your own section in ${inline(Model.phaseTitle(bp, custom.phase), 'phase label')}`);
      facts.push(`- **State:** ${notApplicable ? 'Not applicable — marked as not needed. Anything written here is kept below.' : Model.SECTION_STATE[states[id]]?.[1] || 'Not started'}`);
      parts.push(...facts, '');
      if (custom) {
        parts.push('**What is this section about?**', '', block(custom.description, `section ${id} description`) || NOT_PROVIDED, '');
        for (const key of Object.keys(custom)) if (!['id', 'origin', ...FIELDS.customSections].includes(key)) unsupported.push({ path: `customSections.${id}.${key}`, value: custom[key] });
      } else {
        const body = SECTION[id]();
        parts.push(...(body.length ? body : [NOT_PROVIDED]), '');
      }
      const asked = questionsFor(id, bp.answers);
      if (asked.length) parts.push(custom ? '#### Questions' : '#### Your questions', '', asked.join('\n\n'), '');
      else if (custom) parts.push('#### Questions', '', NOT_PROVIDED, '');
    }
  });
  for (const question of bp.questions) for (const key of Object.keys(question)) if (!['id', 'origin', ...FIELDS.questions].includes(key)) unsupported.push({ path: `questions.${question.id}.${key}`, value: question[key] });
  for (const key of Object.keys(bp)) if (!TOP_FIELDS.includes(key)) unsupported.push({ path: key, value: bp[key] });

  // ---- Report (part of the compared content) and layout appendix (not) ----
  const report = ['<a id="ctx-report"></a>', '## Appendix A. Export report', '',
    `- **Source:** Origin project \`${record.id}\`, export format ${FORMAT_VERSION}. The blueprint revision and generation time are in the header.`,
    `- **Coverage:** ${unsupported.length ? `${unsupported.length} stored ${unsupported.length === 1 ? 'value is' : 'values are'} not supported by this export format; ${unsupported.length === 1 ? 'it is' : 'they are'} listed below as data.` : 'every stored design field is included above.'}`,
    `- **Redactions:** ${redactions.length ? `${redactions.length} ${redactions.length === 1 ? 'field contained text' : 'fields contained text'} that looked like a secret and was replaced with “[redacted]”: ${[...new Set(redactions)].map(where => escapeInline(where)).join('; ')}. Detection is pattern-based and can miss secrets.` : 'none. Detection is pattern-based and can miss secrets.'}`,
    '- **Not included:** Kanban card states, agent sessions and transcripts, Base resource contents (Base references are listed by ID), linked web pages (only stored claims), task-context snapshots (listed by ID) and earlier Project Context documents.',
    ''];
  if (unsupported.length) report.push('**Unsupported values**', '', fence(clean(JSON.stringify(Object.fromEntries(unsupported.map(row => [row.path, row.value])), null, 2), 'unsupported values'), 'json'), '');
  const map = bp.layout.map, layout = ['<a id="ctx-layout"></a>', '## Appendix B. Layout data', '',
    'Positions record where things were drawn in Origin. They are not implementation requirements and are not compared when Origin checks for changes.', '',
    `- **Overview map size:** ${map.width && map.height ? `${map.width} × ${map.height}` : 'automatic'}`, ''];
  const mapNodes = Object.entries(map.nodes);
  layout.push('**Overview map positions**', '', ...(mapNodes.length ? ['| Map node | x | y |', '| --- | --- | --- |', ...mapNodes.map(([key, point]) => `| ${key === 'center' ? 'project' : `${inline(sectionTitle(key), `section ${key} title`)} (\`${key}\`)`} | ${point.x} | ${point.y} |`)] : ['Automatic placement.']), '');
  const placed = bp.components.filter(component => component.x !== null && component.y !== null);
  layout.push('**Architecture canvas positions**', '', ...(placed.length ? ['| Component | x | y |', '| --- | --- | --- |', ...placed.map(component => `| ${ref('components', component.id)} | ${component.x} | ${component.y} |`)] : ['Automatic placement.']), '');
  return { body: [...parts, ...report].join('\n'), layout: layout.join('\n'), toc, redactions: [...new Set(redactions)], unsupported: unsupported.map(row => row.path) };
}

/**
 * Markdown for one saved Origin record. `sourceHash` covers the design content only (not the generation
 * time, the source revision number or layout positions), so it changes only when Origin's content does.
 */
export function exportProjectContext(record, { generatedAt = Date.now() } = {}) {
  const { body, layout, toc, redactions, unsupported } = exporter(record);
  const sourceHash = sha256(`${FORMAT_VERSION}\0${body}`);
  const title = `Project Context: ${record.name}`;
  const preamble = [`# ${escapeInline(title.replace(/\s+/g, ' '))}`, '',
    `> Generated from Origin project \`${record.id}\` at blueprint revision ${record.revision} on ${iso(generatedAt)} (export format ${FORMAT_VERSION}).`,
    '> This is a one-way copy of the saved design. Editing this document does not change Origin, and later Origin changes appear here only when you regenerate it.', '',
    '## Contents', '', ...toc, '- [Appendix A. Export report](#ctx-report)', '- [Appendix B. Layout data](#ctx-layout)', ''];
  const markdown = `${preamble.join('\n')}\n${body}\n${layout}\n`;
  const bytes = Buffer.byteLength(markdown);
  if (bytes > DOCUMENT_BYTES) throw new OriginError(`The Project Context would be ${(bytes / 1048576).toFixed(1)} MB, above the ${DOCUMENT_BYTES / 1048576} MB limit. Nothing was saved; shorten the longest texts in Origin and try again.`, 'CONTEXT_TOO_LARGE', 413);
  return { title, markdown, sourceHash, hash: sha256(markdown), bytes, redactions, unsupported };
}

// ---- Storage ----

const META = 'document.json';
const HASH_FILE = /^[a-f0-9]{64}\.md$/;
const conflict = message => new OriginError(message, 'CONTEXT_REVISION_CONFLICT', 409);
function revisionOf(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new OriginError('Reload the Project Context before saving.', 'INVALID_REVISION');
  return value;
}
function markdownText(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new OriginError('Send the document as Markdown text.', 'INVALID_INPUT');
  if (Buffer.byteLength(value) > DOCUMENT_BYTES) throw new OriginError(`A Project Context can be at most ${DOCUMENT_BYTES / 1048576} MB. Nothing was saved.`, 'CONTEXT_TOO_LARGE', 413);
  return value;
}
const versionView = (meta, version) => ({ id: version.id, number: version.number, formatVersion: version.formatVersion, sourceRevision: version.sourceRevision, generatedAt: version.generatedAt,
  editedAt: version.editedAt, edited: version.textHash !== version.baselineHash, hash: version.textHash, bytes: version.bytes,
  active: version.id === meta.activeVersionId, candidate: version.id === meta.candidateVersionId, redactions: version.redactions, unsupported: version.unsupported });
export const documentView = meta => meta && ({ id: meta.id, originId: meta.originId, title: meta.title, revision: meta.revision, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
  activeVersionId: meta.activeVersionId, candidateVersionId: meta.candidateVersionId, versions: meta.versions.map(version => versionView(meta, version)) });

/** One active Project Context per Origin project, with its generated versions. Separate from the blueprint file. */
export class ContextStore {
  constructor(dataDir) { this.dir = join(dataDir, ORIGIN_DIR, 'context'); this.queue = Promise.resolve(); }
  // ponytail: one queue for all documents; per-project queues if saves ever contend.
  #serial(work) { const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next; }
  #folder(originId) {
    if (typeof originId !== 'string' || !Model.ID.test(originId)) throw new OriginError('Choose a valid project.', 'INVALID_PROJECT');
    return join(this.dir, escapeId(originId));
  }
  async #meta(folder, name = META) {
    let text;
    try { text = await readFile(join(folder, name), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let meta; try { meta = JSON.parse(text); } catch { meta = null; }
    if (meta?.schema === SCHEMA && meta.version > 1) throw new OriginError('This Project Context was saved by a newer Promptboard version. Update the app; the file was not changed.', 'CONTEXT_VERSION_UNSUPPORTED', 409);
    if (meta?.schema === SCHEMA && meta.version === 1 && Array.isArray(meta.versions) && meta.versions.some(version => version.id === meta.activeVersionId)) return meta;
    if (name === META) return this.#meta(folder, `${META}.bak`); // A damaged file falls back to the previous good copy.
    throw new OriginError('The Project Context file is damaged and no good copy was found. Create it again from Origin.', 'CONTEXT_DAMAGED', 500);
  }
  async #text(folder, hash) {
    let text;
    try { text = await readFile(join(folder, `${hash}.md`), 'utf8'); } catch { text = null; }
    if (text === null || sha256(text) !== hash) throw new OriginError('A Project Context file is missing or was changed outside Promptboard. Older versions are unaffected.', 'CONTEXT_DAMAGED', 500);
    return text;
  }
  async #sync(folder) { try { const dir = await open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {} }
  /** Content-addressed and immutable: a file is written once and never changed in place. */
  async #writeText(folder, text) {
    const hash = sha256(text), path = join(folder, `${hash}.md`);
    try { if ((await stat(path)).size === Buffer.byteLength(text)) return hash; } catch {}
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, path);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      throw new OriginError('The Project Context could not be saved. Check free disk space and folder permissions. The previous version is unchanged.', 'CONTEXT_WRITE_FAILED', 500);
    }
    return hash;
  }
  async #writeMeta(folder, meta) {
    const path = join(folder, META), tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(meta, null, 1)}\n`); await handle.sync(); } finally { await handle.close(); }
      try { await copyFile(path, `${path}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(tmp, path);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      throw new OriginError('The Project Context could not be saved. Check free disk space and folder permissions. The previous version is unchanged.', 'CONTEXT_WRITE_FAILED', 500);
    }
    await this.#sync(folder);
  }
  /** Remove text files that neither the current nor the backup metadata uses, and leftover temporary files. */
  async #collect(folder) {
    const keep = new Set();
    for (const name of [META, `${META}.bak`]) {
      try { for (const version of JSON.parse(await readFile(join(folder, name), 'utf8')).versions || []) keep.add(version.baselineHash).add(version.textHash); } catch {}
    }
    for (const name of await readdir(folder)) {
      if ((HASH_FILE.test(name) && !keep.has(name.slice(0, 64))) || name.includes('.tmp-')) await rm(join(folder, name), { force: true }).catch(() => {});
    }
  }
  async #change(originId, expectedRevision, update) {
    const folder = this.#folder(originId), meta = await this.#meta(folder);
    if (!meta) throw new OriginError('This project has no Project Context yet. Create it from Origin.', 'NOT_FOUND', 404);
    if (meta.revision !== revisionOf(expectedRevision)) throw conflict('The Project Context changed in another window. Reload it to see the latest version.');
    const result = await update(meta, folder);
    if (result === false) return meta;
    meta.revision++; meta.updatedAt = Date.now();
    await this.#writeMeta(folder, meta);
    await this.#collect(folder);
    return meta;
  }
  async #generated(folder, meta, record) {
    const generatedAt = Date.now(), exported = exportProjectContext(record, { generatedAt });
    const hash = await this.#writeText(folder, exported.markdown);
    const number = Math.max(0, ...(meta?.versions || []).map(version => version.number)) + 1;
    return { id: randomUUID(), number, formatVersion: FORMAT_VERSION, sourceRevision: record.revision, sourceHash: exported.sourceHash, generatedAt,
      baselineHash: hash, textHash: hash, bytes: exported.bytes, editedAt: null, redactions: exported.redactions, unsupported: exported.unsupported };
  }
  #prune(meta) {
    while (meta.versions.length > VERSION_LIMIT) {
      const index = meta.versions.findIndex(version => version.id !== meta.activeVersionId && version.id !== meta.candidateVersionId);
      if (index < 0) break;
      meta.versions.splice(index, 1);
    }
  }

  read(originId, versionId = null) {
    return this.#serial(async () => {
      const folder = this.#folder(originId), meta = await this.#meta(folder);
      if (!meta) return null;
      const version = meta.versions.find(entry => entry.id === (versionId || meta.activeVersionId));
      if (!version) throw new OriginError('That version of the Project Context no longer exists.', 'NOT_FOUND', 404);
      return { meta, version, text: await this.#text(folder, version.textHash) };
    });
  }
  /** Generate the first version from one saved blueprint record. An existing document is returned unchanged. */
  create(originId, record) {
    return this.#serial(async () => {
      const folder = this.#folder(originId), existing = await this.#meta(folder);
      if (existing) { const version = existing.versions.find(entry => entry.id === existing.activeVersionId); return { meta: existing, version, text: await this.#text(folder, version.textHash), existing: true }; }
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const version = await this.#generated(folder, null, record), now = Date.now();
      const meta = { schema: SCHEMA, version: 1, id: randomUUID(), originId, title: `Project Context: ${record.name}`, revision: 1, createdAt: now, updatedAt: now,
        activeVersionId: version.id, candidateVersionId: null, versions: [version] };
      await this.#writeMeta(folder, meta);
      await this.#collect(folder);
      return { meta, version, text: await this.#text(folder, version.textHash), existing: false };
    });
  }
  /** Save edits to the active version. The generated baseline of that version is kept unchanged. */
  saveText(originId, { expectedRevision, text }) {
    try { markdownText(text); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const meta = await this.#change(originId, expectedRevision, async (meta, folder) => {
        const version = meta.versions.find(entry => entry.id === meta.activeVersionId);
        if (sha256(text) === version.textHash) return false;
        version.textHash = await this.#writeText(folder, text); version.bytes = Buffer.byteLength(text); version.editedAt = Date.now();
      });
      return { meta, version: meta.versions.find(entry => entry.id === meta.activeVersionId) };
    });
  }
  /** A new candidate from the latest saved blueprint. The active version and its edits stay as they are. */
  regenerate(originId, record, { expectedRevision }) {
    return this.#serial(async () => {
      let candidate;
      const meta = await this.#change(originId, expectedRevision, async (meta, folder) => {
        if (meta.candidateVersionId) meta.versions = meta.versions.filter(entry => entry.id !== meta.candidateVersionId);
        candidate = await this.#generated(folder, meta, record);
        meta.versions.push(candidate); meta.candidateVersionId = candidate.id; this.#prune(meta);
      });
      return { meta, candidate, text: await this.#text(this.#folder(originId), candidate.textHash) };
    });
  }
  /** Use the candidate as the new active version, or keep the current one and drop the candidate. */
  resolve(originId, { expectedRevision, use }) {
    if (typeof use !== 'boolean') return Promise.reject(new OriginError('Choose Use new version or Keep current.', 'INVALID_INPUT'));
    return this.#serial(() => this.#change(originId, expectedRevision, async meta => {
      if (!meta.candidateVersionId) throw new OriginError('There is no new version to review. Regenerate from Origin first.', 'NO_CANDIDATE', 409);
      if (use) meta.activeVersionId = meta.candidateVersionId;
      else meta.versions = meta.versions.filter(entry => entry.id !== meta.candidateVersionId);
      meta.candidateVersionId = null; this.#prune(meta);
    }));
  }
  /** On Origin project deletion: keep the files, out of the way. Base copies are independent and stay usable. */
  archive(originId) {
    return this.#serial(async () => {
      const folder = this.#folder(originId);
      try { await stat(folder); } catch { return false; }
      const deleted = join(this.dir, '..', 'deleted');
      await mkdir(deleted, { recursive: true, mode: 0o700 });
      await rename(folder, join(deleted, `context-${escapeId(originId)}.deleted-${Date.now()}`));
      return true;
    });
  }
}

// ---- HTTP: /api/origin/projects/:id/document ----

const sourceHashes = new Map(); // originId → { revision, hash }: avoids re-exporting an unchanged revision on every status check.
function currentSourceHash(record) {
  const known = sourceHashes.get(record.id);
  if (known?.revision === record.revision) return known.hash;
  const { sourceHash } = exportProjectContext(record);
  sourceHashes.set(record.id, { revision: record.revision, hash: sourceHash });
  return sourceHash;
}

/**
 * GET the document (with Origin-changed status), POST to create it from the saved blueprint, PUT edited
 * Markdown, POST /regenerate for a candidate, POST /candidate to use or drop it, GET /versions/:id to read
 * an older version. Every change needs the revision the person last saw; nothing writes the blueprint.
 */
export async function contextRoute({ origin, contexts, req, res, pathname, jsonBody, send, destinations = {} }) {
  const match = pathname.match(/^\/api\/origin\/projects\/([A-Za-z0-9_-]{1,100})\/document(?:\/(regenerate|candidate|base|kanban)|\/versions\/([A-Za-z0-9_-]{1,100}))?$/);
  if (!match) return send(res, 404, { error: 'This Origin route does not exist.' });
  const [, originId, action, versionId] = match, method = req.method;
  const body = async (limit = 1_048_576) => {
    const value = await jsonBody(req, limit);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OriginError('Send a JSON object.', 'INVALID_REQUEST');
    return value;
  };
  const saved = async () => {
    const record = await origin.read(originId);
    if (!record) throw new OriginError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
    if (record.damaged) throw new OriginError('This Origin project file is damaged. Its Project Context was not changed.', 'ORIGIN_DAMAGED', 404);
    return record;
  };
  const reply = async ({ meta, version, text, ...rest }) => {
    const record = await saved(), active = meta.versions.find(entry => entry.id === meta.activeVersionId);
    return send(res, 200, { document: documentView(meta), ...(version ? { version: version.id } : {}), ...(text !== undefined ? { text } : {}),
      sourceRevision: record.revision, originChanged: currentSourceHash(record) !== active.sourceHash, ...rest });
  };
  if (versionId && method === 'GET') {
    const found = await contexts.read(originId, versionId);
    if (!found) throw new OriginError('This project has no Project Context yet.', 'NOT_FOUND', 404);
    return reply(found);
  }
  if (!action && method === 'GET') {
    const found = await contexts.read(originId);
    if (!found) { const record = await saved(); return send(res, 200, { document: null, sourceRevision: record.revision, originChanged: false }); }
    return reply(found);
  }
  if (!action && method === 'POST') {
    const input = await body(), record = await saved();
    // Only a saved revision is converted; the page saves pending edits first and sends the revision it saw.
    if (record.revision !== input.expectedRevision) throw new OriginError('Origin changed after your last save. Reload the project, then create the context again.', 'ORIGIN_REVISION_CONFLICT', 409);
    return reply(await contexts.create(originId, record));
  }
  if (!action && method === 'PUT') {
    const input = await body(2 * DOCUMENT_BYTES + 1_048_576);
    return reply(await contexts.saveText(originId, { expectedRevision: input.expectedRevision, text: input.text }));
  }
  if (action === 'regenerate' && method === 'POST') {
    const input = await body(), record = await saved();
    if (record.revision !== input.expectedSourceRevision) throw new OriginError('Origin changed after your last save. Reload the project, then regenerate.', 'ORIGIN_REVISION_CONFLICT', 409);
    const { meta, candidate, text } = await contexts.regenerate(originId, record, { expectedRevision: input.expectedRevision });
    const current = await contexts.read(originId);
    return reply({ meta, version: current.version, text: current.text, candidate: { id: candidate.id, text } });
  }
  if (action === 'candidate' && method === 'POST') {
    const input = await body();
    await contexts.resolve(originId, { expectedRevision: input.expectedRevision, use: input.use });
    return reply(await contexts.read(originId));
  }
  if ((action === 'base' || action === 'kanban') && method === 'POST' && destinations[action]) return destinations[action]({ originId, input: await body(), contexts, saved, send, res });
  return send(res, 404, { error: 'This Origin route does not exist.' });
}
