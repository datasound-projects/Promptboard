'use strict';

// Origin blueprint model. One definition for the server (validation, the trust boundary) and the
// page (derived state). Pure functions only: verification, issues and readiness are always derived
// from stored records and are never stored themselves, so they cannot become stale or invented.
globalThis.PromptboardOriginModel = (() => {
  const SCHEMA = 'promptboard.origin', VERSION = 2;
  const ID = /^[A-Za-z0-9_-]{1,100}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
  const NAME = 200, TEXT = 20000;

  // The sidebar order of work. Labels can be renamed per project; IDs never change.
  const PHASES = [['define', 'Define', ['overview', 'vision', 'requirements']], ['design', 'Design', ['architecture', 'technology', 'dependencies', 'data', 'ai']],
    ['operate', 'Operate', ['security', 'testing', 'deployment', 'observability']], ['decide', 'Decide', ['research', 'decisions']], ['build', 'Build', ['plan']]]
    .map(([id, label, sections]) => ({ id, label, sections }));
  const SECTIONS = [
    ['overview', 'Overview'], ['vision', 'Vision & Scope'], ['requirements', 'Requirements'], ['architecture', 'Architecture'],
    ['technology', 'Technology'], ['dependencies', 'Dependencies'], ['data', 'Data', true], ['ai', 'AI / Agents', true],
    ['security', 'Security'], ['testing', 'Testing'], ['deployment', 'Deployment', true], ['observability', 'Observability', true],
    ['research', 'Research'], ['decisions', 'Decisions'], ['plan', 'Tasks'],
  ].map(([id, label, optional = false]) => ({ id, label, optional }));

  // [stored value, label]. The first entry is the default.
  const ENUMS = {
    origin: [['human', 'Human-entered'], ['ai', 'AI suggestion'], ['system', 'System-detected']],
    itemStatus: [['draft', 'In progress'], ['defined', 'Defined'], ['needs_decision', 'Needs decision'], ['assumption', 'Based on an assumption']],
    requirementType: [['functional', 'Functional'], ['non_functional', 'Non-functional'], ['technical', 'Technical'], ['security', 'Security'], ['performance', 'Performance'], ['operational', 'Operational']],
    priority: [['should', 'Should'], ['must', 'Must'], ['could', 'Could']],
    componentType: [['service', 'Service'], ['client', 'Client'], ['api', 'API'], ['worker', 'Worker'], ['database', 'Database'], ['storage', 'Storage'], ['queue', 'Queue / messaging'], ['external', 'External system'], ['library', 'Library / module'], ['infrastructure', 'Infrastructure'], ['agent', 'Agent'], ['other', 'Other']],
    techCategory: [['languages', 'Languages'], ['frameworks', 'Frameworks'], ['runtime', 'Runtime'], ['database', 'Database'], ['infrastructure', 'Infrastructure'], ['cloud', 'Cloud'], ['models', 'Models'], ['vector_database', 'Vector database'], ['messaging', 'Messaging'], ['authentication', 'Authentication'], ['observability', 'Observability'], ['ci_cd', 'CI/CD'], ['external_services', 'External services'], ['other', 'Other']],
    techStatus: [['candidate', 'Candidate'], ['selected', 'Selected'], ['rejected', 'Rejected']],
    dependencyType: [['package', 'Package'], ['internal', 'Internal'], ['service', 'External service'], ['api', 'API'], ['sdk', 'SDK'], ['cli', 'CLI tool'], ['mcp', 'MCP'], ['infrastructure', 'Infrastructure'], ['runtime', 'Runtime']],
    decisionStatus: [['proposed', 'Proposed'], ['accepted', 'Accepted'], ['superseded', 'Superseded'], ['rejected', 'Rejected']],
    assumptionStatus: [['open', 'Open'], ['validated', 'Resolved: holds'], ['invalid', 'Invalid'], ['converted', 'Converted to decision']],
    sourceType: [['documentation', 'Official documentation'], ['repository', 'Official repository'], ['standard', 'Standard'], ['vendor', 'Vendor documentation'], ['primary', 'Primary source'], ['article', 'Article / secondary'], ['other', 'Other']],
    sourceVerification: [['unverified', 'Unverified'], ['verified', 'Verified'], ['outdated', 'Outdated'], ['conflicting', 'Conflicting']],
    riskKind: [['risk', 'Risk'], ['conflict', 'Conflict'], ['missing', 'Missing information'], ['unverified', 'Unverified dependency'], ['unresolved', 'Unresolved decision']],
    severity: [['medium', 'Medium'], ['high', 'High'], ['low', 'Low']],
    riskStatus: [['open', 'Open'], ['mitigated', 'Mitigated'], ['accepted', 'Accepted'], ['closed', 'Closed']],
    workStatus: [['planned', 'Planned'], ['ready', 'Ready'], ['in_progress', 'In progress'], ['done', 'Done']],
  };
  const AREAS = {
    data: [['sources', 'Data sources'], ['schemas', 'Schemas'], ['storage', 'Storage'], ['flows', 'Data flows'], ['processing', 'Processing'], ['pipelines', 'Pipelines'], ['retention', 'Retention'], ['privacy', 'Privacy'], ['ownership', 'Ownership']],
    ai: [['models', 'Models'], ['agents', 'Agents and responsibilities'], ['tools', 'Tools'], ['mcps', 'MCPs'], ['knowledge', 'Knowledge'], ['context', 'Context sources'], ['retrieval', 'Retrieval'], ['vector_stores', 'Vector stores'], ['memory', 'Memory'], ['prompt_boundaries', 'Prompt boundaries'], ['orchestration', 'Orchestration'], ['evaluation', 'Evaluation'], ['guardrails', 'Guardrails'], ['fallbacks', 'Fallbacks']],
    security: [['authentication', 'Authentication'], ['authorization', 'Authorization'], ['secrets', 'Secrets'], ['permissions', 'Permissions'], ['data_sensitivity', 'Data sensitivity'], ['integrations', 'External integrations'], ['threats', 'Threats'], ['input_validation', 'Input validation'], ['supply_chain', 'Supply-chain dependencies'], ['auditability', 'Auditability'], ['network_exposure', 'Network exposure']],
    testing: [['unit', 'Unit tests'], ['integration', 'Integration tests'], ['e2e', 'End-to-end tests'], ['contract', 'Contract tests'], ['security', 'Security tests'], ['performance', 'Performance tests'], ['model_eval', 'Model evaluations'], ['agent_eval', 'Agent evaluations'], ['acceptance', 'Acceptance tests']],
    deployment: [['environments', 'Environments'], ['runtime', 'Runtime'], ['containers', 'Containers'], ['infrastructure', 'Infrastructure'], ['hosting', 'Cloud / local'], ['configuration', 'Configuration'], ['secrets', 'Secrets'], ['networking', 'Networking'], ['scaling', 'Scaling'], ['backups', 'Backups'], ['recovery', 'Recovery'], ['ci_cd', 'CI/CD']],
    observability: [['logs', 'Logs'], ['metrics', 'Metrics'], ['traces', 'Traces'], ['alerts', 'Alerts'], ['dashboards', 'Dashboards'], ['slos', 'SLOs'], ['health_checks', 'Health checks'], ['ai_metrics', 'AI metrics'], ['model_metrics', 'Model metrics'], ['cost_usage', 'Cost / usage metrics']],
  };
  const VISION = ['summary', 'problem', 'goal', 'users', 'useCases', 'inScope', 'outOfScope', 'successCriteria', 'constraints', 'architectureSummary'];
  const LIMITS = { requirements: 500, components: 200, connections: 1000, technologies: 300, dependencies: 500, decisions: 300, assumptions: 300, sources: 500, risks: 300, areas: 1000, milestones: 100, items: 1000,
    layers: 50, customSections: 50, questions: 300 };
  // Records a task can link through More details, beyond its components, requirements and prerequisites.
  const CONTEXT_COLLECTIONS = ['decisions', 'technologies', 'dependencies', 'areas', 'sources', 'assumptions', 'risks', 'customSections'];
  const QUESTION_KEY = /^(section|vision|topic|field):[A-Za-z0-9_:-]{1,100}$/;
  // Built-in wording shown in Origin. Each project can reword it (questionText); the wording never changes what a section does.
  const QUESTIONS = {
    overview: 'Your whole project on one map. Click any branch to work on it.',
    vision: 'Why does this exist, and who is it for?',
    requirements: 'What must it do — and how will you know it works?',
    architecture: 'What are the building blocks, and how do they connect?',
    technology: 'What will you build it with, and why?',
    dependencies: 'What does it rely on that you do not build yourself?',
    data: 'What data does it handle, and where does it live?',
    ai: 'Where does AI help, and how is it kept in check?',
    security: 'How is it protected?',
    testing: 'How will you prove it works?',
    deployment: 'Where and how does it run?',
    observability: 'How will you see what is happening?',
    research: 'What did you check, what are you assuming, and what could go wrong?',
    decisions: 'What have you decided, and why?',
    plan: 'What needs to be built, and where?',
  };
  const VISION_QUESTIONS = { summary: 'In one sentence, what is it?', problem: 'What problem does it solve?', goal: 'What is the goal?', users: 'Who is it for?', useCases: 'What will they do with it?',
    inScope: 'What is included?', outOfScope: 'What is not included?', successCriteria: 'How will you know it worked?', constraints: 'Any limits?', architectureSummary: 'Architecture summary' };
  const COMPONENT_FIELDS = { purpose: 'What it does', responsibilities: 'Responsibilities', interfaces: 'Interfaces', dataHandled: 'Data it handles' };
  const KEYS = { requirements: 'REQ', decisions: 'ADR', items: 'IMP' };

  class OriginModelError extends Error { constructor(message) { super(message); this.code = 'ORIGIN_INVALID'; this.status = 400; } }
  const label = (name, value) => ((ENUMS[name] || AREAS[name] || []).find(([id]) => id === value) || [value, value])[1];
  const sectionLabel = id => SECTIONS.find(section => section.id === id)?.label || id;
  /** The project's own names: renamed built-in sections and phases, and custom section titles. */
  const sectionTitle = (blueprint, id) => {
    const custom = blueprint?.customSections?.find(section => section.id === id);
    return blueprint?.labels?.sections?.[id] || (custom ? custom.title.trim() || 'Untitled section' : sectionLabel(id));
  };
  const phaseTitle = (blueprint, id) => blueprint?.labels?.phases?.[id] || PHASES.find(phase => phase.id === id)?.label || id;
  /** The sidebar for one project: its phase names, built-in sections first, then its own sections. */
  const phaseList = blueprint => PHASES.map(phase => ({ id: phase.id, label: phaseTitle(blueprint, phase.id),
    sections: [...phase.sections, ...(blueprint?.customSections || []).filter(section => section.phase === phase.id).map(section => section.id)] }));
  /** A guiding question in the project's own words, or the built-in wording. */
  const questionText = (blueprint, key, fallback) => blueprint?.questionText?.[key] || fallback;
  const formatKey = (prefix, number) => `${prefix}-${String(number).padStart(3, '0')}`;
  const keyNumber = (key, prefix) => { const match = typeof key === 'string' ? key.match(new RegExp(`^${prefix}-(\\d{1,6})$`)) : null; return match ? Number(match[1]) : 0; };
  const lines = text => String(text || '').split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);

  function emptyBlueprint() {
    return { idea: '', vision: Object.fromEntries(VISION.map(key => [key, ''])), sections: {}, sequence: { requirements: 0, decisions: 0, items: 0 },
      labels: { phases: {}, sections: {} }, answers: {}, questionText: {}, layout: { map: { width: null, height: null, nodes: {}, links: [] } },
      ...Object.fromEntries(Object.keys(LIMITS).map(name => [name, []])) };
  }

  /** Reserve the next stable display key (REQ-001, ADR-001, IMP-001). Keys are never reused. */
  function nextKey(blueprint, collection) {
    const prefix = KEYS[collection];
    const next = Math.max(blueprint.sequence?.[collection] || 0, ...blueprint[collection].map(entry => keyNumber(entry.key, prefix))) + 1;
    blueprint.sequence = { ...blueprint.sequence, [collection]: next };
    return formatKey(prefix, next);
  }

  /**
   * Validate untrusted input into a complete blueprint. Unknown fields are dropped, invalid values
   * fall back to safe defaults and dangling references are removed; `repairs` counts every change.
   * Only collection limits are rejected outright, so nothing is silently cut in half.
   */
  function normalizeBlueprint(input) {
    let repairs = 0;
    const fix = () => { repairs++; };
    const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const obj = value => { if (isObject(value)) return value; if (value !== undefined && value !== null) fix(); return {}; };
    const str = (value, max = TEXT) => {
      if (value === undefined || value === null) return '';
      if (typeof value !== 'string') { fix(); return ''; }
      const clean = value.replace(/\u0000/g, '');
      if (clean.length > max || clean !== value) { fix(); return clean.slice(0, max); }
      return clean;
    };
    const pick = (value, list) => { if (list.some(([id]) => id === value)) return value; if (value !== undefined && value !== null && value !== '') fix(); return list[0][0]; };
    const date = value => { if (value === undefined || value === null || value === '') return ''; if (typeof value === 'string' && DATE.test(value)) return value; fix(); return ''; };
    const num = value => { if (value === undefined || value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value)) { fix(); return null; } return Math.max(-100000, Math.min(100000, Math.round(value))); };
    const url = value => {
      const text = str(value, 2000).trim();
      if (!text) return '';
      try {
        const parsed = new URL(text);
        if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return text;
      } catch {}
      fix(); return '';
    };
    const source = obj(input);
    const raw = name => { if (Array.isArray(source[name])) return source[name]; if (source[name] !== undefined) fix(); return []; };
    const ids = {};
    for (const name of Object.keys(LIMITS)) {
      if (raw(name).length > LIMITS[name]) throw new OriginModelError(`A blueprint can have at most ${LIMITS[name]} ${name}.`);
      ids[name] = new Set(raw(name).map(entry => isObject(entry) ? entry.id : null).filter(id => typeof id === 'string' && ID.test(id)));
    }
    const refs = (value, set, self) => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) { fix(); return []; }
      const list = [];
      for (const id of value.slice(0, 500)) { if (typeof id === 'string' && set.has(id) && id !== self && !list.includes(id)) list.push(id); else fix(); }
      if (value.length > 500) fix();
      return list;
    };
    const one = (value, set, self) => { if (value === undefined || value === null || value === '') return ''; if (typeof value === 'string' && set.has(value) && value !== self) return value; fix(); return ''; };
    const external = value => { // Base resource IDs: format only. Origin never reads or writes Base content.
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) { fix(); return []; }
      const list = value.filter(id => typeof id === 'string' && ID.test(id)).filter((id, index, all) => all.indexOf(id) === index).slice(0, 100);
      if (list.length !== value.length) fix();
      return list;
    };
    const collection = (name, shape) => {
      const seen = new Set(), list = [];
      for (const entry of raw(name)) {
        const value = obj(entry);
        if (typeof value.id !== 'string' || !ID.test(value.id) || seen.has(value.id)) { fix(); continue; }
        seen.add(value.id);
        list.push({ id: value.id, origin: pick(value.origin, ENUMS.origin), ...shape(value) });
      }
      return list;
    };
    const blueprint = { idea: str(source.idea), vision: {}, sections: {}, sequence: {} };
    const vision = obj(source.vision);
    for (const key of VISION) blueprint.vision[key] = str(vision[key]);
    const sections = obj(source.sections);
    for (const { id, optional } of SECTIONS) if (optional && obj(sections[id]).notApplicable === true) blueprint.sections[id] = { notApplicable: true };
    const sequence = obj(source.sequence);

    // Per-project wording: renamed phases and sections, custom sections and their questions. Behaviour
    // always follows the stable built-in IDs, never the editable labels.
    const builtinIds = new Set(SECTIONS.map(section => section.id)), phaseIds = PHASES.map(phase => phase.id);
    const labels = obj(source.labels), labelPhases = obj(labels.phases), labelSections = obj(labels.sections);
    blueprint.labels = { phases: {}, sections: {} };
    for (const id of phaseIds) { const value = str(labelPhases[id], 60).trim(); if (value) blueprint.labels.phases[id] = value; }
    for (const id of builtinIds) { const value = str(labelSections[id], 60).trim(); if (value) blueprint.labels.sections[id] = value; }
    for (const key of [...Object.keys(labelPhases), ...Object.keys(labelSections)]) if (!phaseIds.includes(key) && !builtinIds.has(key)) fix();
    blueprint.customSections = collection('customSections', v => ({ phase: phaseIds.includes(v.phase) ? v.phase : (fix(), 'define'), title: str(v.title, 80),
      description: str(v.description, 2000), notApplicable: v.notApplicable === true }))
      .filter(entry => { if (!builtinIds.has(entry.id)) return true; fix(); return false; });
    const sectionIds = new Set([...builtinIds, ...blueprint.customSections.map(entry => entry.id)]);
    blueprint.questions = collection('questions', v => {
      const scope = v.scope === 'component' ? 'component' : v.scope === 'section' ? 'section' : (fix(), 'section');
      const sectionId = scope === 'section' && typeof v.sectionId === 'string' && sectionIds.has(v.sectionId) ? v.sectionId : '';
      if (scope === 'section' && !sectionId) fix();
      return { scope, sectionId, text: str(v.text, 500) };
    }).filter(entry => entry.scope === 'component' || entry.sectionId);
    const questionIds = scope => new Set(blueprint.questions.filter(entry => entry.scope === scope).map(entry => entry.id));
    const sectionQuestions = questionIds('section'), componentQuestions = questionIds('component');
    // Answers belong to a question ID, so renaming a question never detaches or moves its answer.
    const answers = (value, allowed) => {
      const result = {};
      for (const [key, text] of Object.entries(obj(value))) {
        if (!allowed.has(key)) { fix(); continue; }
        const answer = str(text);
        if (answer) result[key] = answer;
      }
      return result;
    };
    blueprint.answers = answers(source.answers, sectionQuestions);
    const edited = Object.entries(obj(source.questionText));
    if (edited.length > 500) throw new OriginModelError('A blueprint can have at most 500 edited questions.');
    blueprint.questionText = {};
    for (const [key, text] of edited) {
      if (!QUESTION_KEY.test(key)) { fix(); continue; }
      const value = str(text, 500).trim();
      if (value) blueprint.questionText[key] = value;
    }
    blueprint.layers = collection('layers', v => ({ name: str(v.name, 80), description: str(v.description, 2000), technologyIds: refs(v.technologyIds, ids.technologies), constraints: str(v.constraints) }));

    blueprint.requirements = collection('requirements', v => ({ key: str(v.key, 20), title: str(v.title, NAME), description: str(v.description),
      type: pick(v.type, ENUMS.requirementType), priority: pick(v.priority, ENUMS.priority), status: pick(v.status, ENUMS.itemStatus),
      acceptanceCriteria: str(v.acceptanceCriteria), componentIds: refs(v.componentIds, ids.components), sourceIds: refs(v.sourceIds, ids.sources) }));
    blueprint.components = collection('components', v => ({ name: str(v.name, NAME), type: pick(v.type, ENUMS.componentType), purpose: str(v.purpose),
      responsibilities: str(v.responsibilities), technologyIds: refs(v.technologyIds, ids.technologies), interfaces: str(v.interfaces), dataHandled: str(v.dataHandled),
      status: pick(v.status, ENUMS.itemStatus), notes: str(v.notes), sourceIds: refs(v.sourceIds, ids.sources), x: num(v.x), y: num(v.y),
      layerId: one(v.layerId, ids.layers), answers: answers(v.answers, componentQuestions) }));
    blueprint.connections = collection('connections', v => ({ from: one(v.from, ids.components), to: one(v.to, ids.components),
      label: str(v.label, 80), protocol: str(v.protocol, 80), notes: str(v.notes, 2000) }))
      .filter(connection => { const valid = connection.from && connection.to && connection.from !== connection.to; if (!valid) fix(); return valid; });
    blueprint.technologies = collection('technologies', v => ({ name: str(v.name, NAME), category: pick(v.category, ENUMS.techCategory), purpose: str(v.purpose),
      version: str(v.version, 80), status: pick(v.status, ENUMS.techStatus), reason: str(v.reason), alternatives: str(v.alternatives), sourceIds: refs(v.sourceIds, ids.sources) }));
    blueprint.dependencies = collection('dependencies', v => ({ name: str(v.name, NAME), type: pick(v.type, ENUMS.dependencyType), version: str(v.version, 80),
      requiredBy: refs(v.requiredBy, ids.components), dependsOn: refs(v.dependsOn, ids.dependencies, v.id), sourceIds: refs(v.sourceIds, ids.sources), notes: str(v.notes) }));
    blueprint.decisions = collection('decisions', v => ({ key: str(v.key, 20), title: str(v.title, NAME), context: str(v.context), decision: str(v.decision),
      alternatives: str(v.alternatives), reason: str(v.reason), consequences: str(v.consequences), status: pick(v.status, ENUMS.decisionStatus), date: date(v.date),
      supersededBy: one(v.supersededBy, ids.decisions, v.id), componentIds: refs(v.componentIds, ids.components), technologyIds: refs(v.technologyIds, ids.technologies),
      requirementIds: refs(v.requirementIds, ids.requirements), dependencyIds: refs(v.dependencyIds, ids.dependencies), sourceIds: refs(v.sourceIds, ids.sources) }));
    blueprint.assumptions = collection('assumptions', v => ({ statement: str(v.statement, 2000), reason: str(v.reason), impact: str(v.impact),
      status: pick(v.status, ENUMS.assumptionStatus), decisionId: one(v.decisionId, ids.decisions), sourceIds: refs(v.sourceIds, ids.sources) }));
    blueprint.sources = collection('sources', v => ({ title: str(v.title, NAME), url: url(v.url), type: pick(v.type, ENUMS.sourceType), claim: str(v.claim, 4000),
      accessedAt: date(v.accessedAt), verification: pick(v.verification, ENUMS.sourceVerification), notes: str(v.notes) }));
    blueprint.risks = collection('risks', v => ({ title: str(v.title, NAME), description: str(v.description), kind: pick(v.kind, ENUMS.riskKind),
      severity: pick(v.severity, ENUMS.severity), mitigation: str(v.mitigation), status: pick(v.status, ENUMS.riskStatus), componentIds: refs(v.componentIds, ids.components) }));
    blueprint.areas = collection('areas', v => {
      const section = Object.hasOwn(AREAS, v.section) ? v.section : (fix(), 'data');
      return { section, area: pick(v.area, AREAS[section]), title: str(v.title, NAME), description: str(v.description), status: pick(v.status, ENUMS.itemStatus),
        componentIds: refs(v.componentIds, ids.components), requirementIds: refs(v.requirementIds, ids.requirements), technologyIds: refs(v.technologyIds, ids.technologies),
        baseResourceIds: external(v.baseResourceIds) };
    });
    blueprint.milestones = collection('milestones', v => ({ title: str(v.title, NAME), goal: str(v.goal), definitionOfDone: str(v.definitionOfDone) }));
    const contextRefs = value => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) { fix(); return []; }
      const list = [];
      for (const entry of value.slice(0, 100)) {
        const ref = obj(entry);
        if (CONTEXT_COLLECTIONS.includes(ref.collection) && ids[ref.collection].has(ref.id) && !list.some(item => item.collection === ref.collection && item.id === ref.id)) list.push({ collection: ref.collection, id: ref.id });
        else fix();
      }
      if (value.length > 100) fix();
      return list;
    };
    const stamp = value => (Number.isSafeInteger(value) && value > 0 ? value : null);
    blueprint.items = collection('items', v => {
      const h = obj(v.handoff), hash = typeof h.hash === 'string' && /^[a-f0-9]{64}$/.test(h.hash) ? h.hash : '';
      const handoff = isObject(v.handoff) && ID.test(h.projectId) && ID.test(h.taskId) && Number.isSafeInteger(h.at)
        ? { projectId: h.projectId, taskId: h.taskId, at: h.at, snapshotId: typeof h.snapshotId === 'string' && ID.test(h.snapshotId) ? h.snapshotId : '', hash,
          keptHash: typeof h.keptHash === 'string' && /^[a-f0-9]{64}$/.test(h.keptHash) ? h.keptHash : '' } : (v.handoff === undefined || v.handoff === null ? null : (fix(), null));
      // A removed component leaves a note on its tasks, so the missing link stays visible until relinked.
      const lost = v.lostLinks === undefined || v.lostLinks === null ? [] : Array.isArray(v.lostLinks) ? v.lostLinks : (fix(), []);
      const lostLinks = lost.slice(0, 20).map(obj).filter(entry => entry.collection === 'components' && typeof entry.name === 'string').map(entry => ({ collection: 'components', name: str(entry.name, NAME) }));
      if (lostLinks.length !== lost.length) fix();
      const r = obj(v.refinement);
      const refinement = isObject(v.refinement) ? { proposal: str(r.proposal, 100000), proposedAt: stamp(r.proposedAt), basis: str(r.basis, 100000), originalDescription: str(r.originalDescription, 100000), acceptedAt: stamp(r.acceptedAt) }
        : (v.refinement === undefined || v.refinement === null ? null : (fix(), null));
      return { key: str(v.key, 20), milestoneId: one(v.milestoneId, ids.milestones), workstream: str(v.workstream, 80), title: str(v.title, NAME), description: str(v.description),
        acceptanceCriteria: str(v.acceptanceCriteria), dependsOn: refs(v.dependsOn, ids.items, v.id), requirementIds: refs(v.requirementIds, ids.requirements),
        componentIds: refs(v.componentIds, ids.components), layerId: one(v.layerId, ids.layers), contextIds: contextRefs(v.contextIds), status: pick(v.status, ENUMS.workStatus), handoff, refinement, lostLinks };
    });
    // Layout is presentation only: node positions and decorative map links never mean dependencies.
    const layout = obj(source.layout), map = obj(layout.map), nodeKeys = new Set(['center', ...sectionIds]);
    const size = (value, min, max) => { if (value === undefined || value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value)) { fix(); return null; } return Math.max(min, Math.min(max, Math.round(value))); };
    const nodeEntries = Object.entries(obj(map.nodes)), rawLinks = map.links === undefined ? [] : Array.isArray(map.links) ? map.links : (fix(), []);
    if (nodeEntries.length > 300 || rawLinks.length > 300) throw new OriginModelError('A project map can have at most 300 nodes and 300 links.');
    const nodes = {};
    for (const [key, value] of nodeEntries) {
      const point = obj(value), x = num(point.x), y = num(point.y);
      if (nodeKeys.has(key) && x !== null && y !== null) nodes[key] = { x, y }; else fix();
    }
    const links = [], linkIds = new Set();
    for (const value of rawLinks) {
      const link = obj(value);
      if (typeof link.id === 'string' && ID.test(link.id) && !linkIds.has(link.id) && nodeKeys.has(link.from) && nodeKeys.has(link.to) && link.from !== link.to) {
        linkIds.add(link.id); links.push({ id: link.id, from: link.from, to: link.to, label: str(link.label, 80) });
      } else fix();
    }
    blueprint.layout = { map: { width: size(map.width, 480, 4000), height: size(map.height, 320, 4000), nodes, links } };
    // Stable, unique display keys. A missing or duplicate key gets the next number; numbers are not reused.
    for (const [name, prefix] of Object.entries(KEYS)) {
      const stored = Number.isSafeInteger(sequence[name]) && sequence[name] > 0 ? sequence[name] : 0;
      let next = Math.max(stored, ...blueprint[name].map(entry => keyNumber(entry.key, prefix)));
      const used = new Set();
      for (const entry of blueprint[name]) {
        const number = keyNumber(entry.key, prefix);
        if (!number || used.has(number)) { if (entry.key) fix(); entry.key = formatKey(prefix, ++next); }
        used.add(keyNumber(entry.key, prefix));
      }
      blueprint.sequence[name] = next;
    }
    return { blueprint, repairs };
  }

  // ---- Derived state ----

  const byId = list => new Map(list.map(entry => [entry.id, entry]));
  const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
  const hasText = value => typeof value === 'string' && value.trim().length > 0;

  /** Evidence decides verification. A URL alone never verifies anything. */
  function verification(entity, sources) {
    const map = sources instanceof Map ? sources : byId(sources);
    const linked = (entity.sourceIds || []).map(id => map.get(id)).filter(Boolean);
    if (linked.some(source => source.verification === 'conflicting')) return 'conflict';
    if (linked.some(source => source.verification === 'verified')) return 'verified';
    if (linked.some(source => source.verification === 'outdated')) return 'outdated';
    return 'unverified';
  }
  const VERIFICATION_LABELS = { verified: 'Verified', unverified: 'Unverified', outdated: 'Outdated', conflict: 'Conflict' };

  function isStarted(blueprint) {
    return Boolean(blueprint) && (hasText(blueprint.idea) || VISION.some(key => hasText(blueprint.vision?.[key])) || Object.keys(LIMITS).some(name => blueprint[name]?.length));
  }

  // ---- Task context: one builder for handoff, refinement and change detection ----

  const CONTEXT_LIMIT = 60000;
  const CROSS_CUTTING = new Set(['non_functional', 'security', 'performance', 'operational']);
  const mentions = (text, name) => hasText(name) && new RegExp(`(^|[^\\p{L}\\p{N}])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text);

  /**
   * The context for one task, chosen from its own links: its components and their layer, one hop of
   * connections, its requirements (plus project-wide quality requirements), prerequisites, applicable
   * accepted decisions, dependencies, tests, linked planning answers and anything linked under More
   * details. Never the whole blueprint. Deterministic: the same saved blueprint gives the same text.
   * The task's own words are kept exactly; context is separate reference material.
   */
  function taskContext(blueprint, itemId, { projectName = '', limit = CONTEXT_LIMIT } = {}) {
    const item = blueprint.items.find(entry => entry.id === itemId);
    if (!item) return null;
    const get = collection => byId(blueprint[collection]), components = get('components'), technologies = get('technologies'), sources = get('sources');
    const explicit = collection => new Set((item.contextIds || []).filter(ref => ref.collection === collection).map(ref => ref.id));
    const notNeeded = id => Boolean(blueprint.sections[id]?.notApplicable);
    const included = [], seen = new Set(), warnings = [];
    const use = (collection, entry, name = itemName(blueprint, collection, entry.id) || entry.title || entry.name || 'Untitled') => {
      const key = `${collection}:${entry.id}`;
      if (!seen.has(key)) { seen.add(key); included.push({ collection, id: entry.id, name }); }
    };
    const tech = id => {
      const entry = technologies.get(id);
      if (!entry || entry.status === 'rejected') return '';
      return `${entry.name}${entry.version ? ` ${entry.version}` : ''}${entry.status === 'candidate' ? ' (candidate — not decided)' : ''}`;
    };
    const linked = item.componentIds.map(id => components.get(id)).filter(Boolean);
    const layerIds = linked.length ? [...new Set(linked.map(component => component.layerId).filter(Boolean))] : [item.layerId].filter(Boolean);
    const layers = layerIds.map(id => blueprint.layers.find(layer => layer.id === id)).filter(Boolean);
    const componentIds = new Set(linked.map(component => component.id));
    const requirements = [...item.requirementIds.map(id => blueprint.requirements.find(entry => entry.id === id)).filter(Boolean),
      ...blueprint.requirements.filter(entry => !entry.componentIds.length && CROSS_CUTTING.has(entry.type) && !item.requirementIds.includes(entry.id))];
    const requirementIds = new Set(requirements.map(entry => entry.id));
    const stackIds = new Set([...layers.flatMap(layer => layer.technologyIds), ...linked.flatMap(component => component.technologyIds)]);
    const dependencies = blueprint.dependencies.filter(entry => entry.requiredBy.some(id => componentIds.has(id)) || explicit('dependencies').has(entry.id));
    const dependencyIds = new Set(dependencies.map(entry => entry.id));
    const evidence = new Set();
    const cite = entry => { for (const id of entry.sourceIds || []) evidence.add(id); };
    // Each block: title, body, and whether it may be left out when the context is too large.
    const blocks = [];
    const push = (title, body, optional = true) => { if (hasText(body)) blocks.push({ title, body: body.trim(), optional }); };

    // The project: purpose, scope and constraints. Boundaries and constraints are never left out.
    const vision = blueprint.vision;
    push('Project', [`${projectName || 'Unnamed project'}${hasText(vision.summary) ? ` — ${clip(vision.summary, 600)}` : ''}`,
      hasText(vision.goal) && `Goal: ${clip(vision.goal, 600)}`, hasText(vision.inScope) && `In scope:\n${bullets(lines(vision.inScope).map(line => clip(line, 300)))}`].filter(Boolean).join('\n'));
    push('Out of scope', vision.outOfScope, false);
    push('Project constraints', vision.constraints, false);
    for (const layer of layers) {
      use('layers', layer, layer.name || 'Unnamed layer');
      const stack = layer.technologyIds.map(tech).filter(Boolean);
      for (const id of layer.technologyIds) if (technologies.get(id) && technologies.get(id).status !== 'rejected') { use('technologies', technologies.get(id)); cite(technologies.get(id)); }
      push(`Layer: ${layer.name || 'Unnamed layer'}`, [hasText(layer.description) && clip(layer.description, 1500), stack.length && `Stack: ${stack.join(', ')}`].filter(Boolean).join('\n'));
      push(`Shared rules for ${layer.name || 'this layer'}`, layer.constraints, false);
    }
    // Components, their own answers, and one hop of connections with the neighbours' interfaces.
    for (const component of linked) {
      use('components', component); cite(component);
      const own = blueprint.questions.filter(question => question.scope === 'component' && hasText(component.answers?.[question.id]))
        .map(question => `${clip(question.text, 300)} → ${clip(component.answers[question.id], 1500)}`);
      const stack = component.technologyIds.map(tech).filter(Boolean);
      for (const id of component.technologyIds) if (technologies.get(id) && technologies.get(id).status !== 'rejected') { use('technologies', technologies.get(id)); cite(technologies.get(id)); }
      if (component.status === 'needs_decision') warnings.push(`${component.name || 'A linked component'} still needs a decision.`);
      push(`Component: ${component.name || 'Unnamed component'} (${label('componentType', component.type)})`, [hasText(component.purpose) && clip(component.purpose, 1500),
        hasText(component.responsibilities) && `Responsibilities:\n${bullets(lines(component.responsibilities).map(line => clip(line, 400)))}`,
        hasText(component.interfaces) && `Interfaces: ${clip(component.interfaces, 1500)}`, hasText(component.dataHandled) && `Data: ${clip(component.dataHandled, 1000)}`,
        stack.length && `Technologies: ${stack.join(', ')}`, own.length && bullets(own)].filter(Boolean).join('\n'));
      const near = blueprint.connections.filter(connection => connection.from === component.id || connection.to === component.id).map(connection => {
        const out = connection.from === component.id, other = components.get(out ? connection.to : connection.from);
        if (!other) return '';
        const via = [connection.label, connection.protocol].filter(hasText).join(', ');
        return `${out ? '→' : '←'} ${other.name || 'Unnamed component'} (${label('componentType', other.type)})${via ? ` — ${via}` : ''}${hasText(other.interfaces) ? `; its interfaces: ${clip(other.interfaces, 600)}` : ''}`;
      }).filter(Boolean);
      push(`Connections of ${component.name || 'this component'}`, bullets(near));
    }
    // Requirements keep every acceptance criterion; project-wide quality requirements apply to every task.
    for (const requirement of requirements) {
      use('requirements', requirement); cite(requirement);
      push(`Requirement ${requirement.key} ${requirement.title}${requirement.componentIds.length || item.requirementIds.includes(requirement.id) ? '' : ' (project-wide)'}`,
        [`${label('requirementType', requirement.type)} · ${label('priority', requirement.priority)}`, hasText(requirement.description) && clip(requirement.description, 1500),
          lines(requirement.acceptanceCriteria).length && `Accepted when:\n${requirement.acceptanceCriteria.trim()}`].filter(Boolean).join('\n'), !lines(requirement.acceptanceCriteria).length);
    }
    // Prerequisites set the build order; nothing else does.
    const before = item.dependsOn.map(id => blueprint.items.find(entry => entry.id === id)).filter(Boolean);
    for (const entry of before) use('items', entry);
    push('Starts after', bullets(before.map(entry => `${entry.key} ${entry.title || 'Untitled task'}${lines(entry.acceptanceCriteria).length ? ` — done when: ${lines(entry.acceptanceCriteria).map(line => clip(line, 200)).join('; ')}` : ''}`)));
    // Accepted decisions that apply; open ones are named as open, never as decided.
    const applies = decision => decision.componentIds.some(id => componentIds.has(id)) || decision.requirementIds.some(id => requirementIds.has(id))
      || decision.technologyIds.some(id => stackIds.has(id)) || decision.dependencyIds.some(id => dependencyIds.has(id)) || explicit('decisions').has(decision.id);
    const decisions = blueprint.decisions.filter(applies);
    for (const decision of decisions.filter(entry => entry.status === 'accepted')) { use('decisions', decision); cite(decision); }
    push('Accepted decisions to respect', bullets(decisions.filter(entry => entry.status === 'accepted').map(entry => `${entry.key} ${entry.title}: ${clip(entry.decision, 800)}${hasText(entry.reason) ? ` (reason: ${clip(entry.reason, 400)})` : ''}`)), false);
    for (const decision of decisions.filter(entry => entry.status === 'proposed')) warnings.push(`${decision.key} ${decision.title || 'A decision'} is still open.`);
    // Dependencies with their verification state, tests, milestone, planning answers.
    for (const dependency of dependencies) { use('dependencies', dependency); cite(dependency); }
    push('Dependencies', bullets(dependencies.map(entry => `${entry.name}${entry.version ? ` ${entry.version}` : ''} (${label('dependencyType', entry.type)}) — ${VERIFICATION_LABELS[verification(entry, blueprint.sources)].toLowerCase()}`)));
    const areas = blueprint.areas.filter(area => !notNeeded(area.section) && hasText(area.title)
      && (area.componentIds.some(id => componentIds.has(id)) || area.requirementIds.some(id => requirementIds.has(id)) || explicit('areas').has(area.id)));
    for (const area of areas) use('areas', area, `${sectionLabel(area.section)} · ${label(area.section, area.area)}`);
    const tests = areas.filter(area => area.section === 'testing'), plans = areas.filter(area => area.section !== 'testing');
    push('Planned tests', bullets(tests.map(area => `${label('testing', area.area)}: ${area.title}${hasText(area.description) ? ` — ${clip(area.description, 600)}` : ''}`)));
    push('Data, AI, security, deployment and observability', bullets(plans.map(area => `${sectionLabel(area.section)} · ${label(area.section, area.area)}: ${area.title}${hasText(area.description) ? ` — ${clip(area.description, 600)}` : ''}`)));
    const milestone = blueprint.milestones.find(entry => entry.id === item.milestoneId);
    if (milestone) { use('milestones', milestone); push(`Milestone: ${milestone.title || 'Untitled milestone'}`, [hasText(milestone.goal) && clip(milestone.goal, 600), lines(milestone.definitionOfDone).length && `Done when:\n${milestone.definitionOfDone.trim()}`].filter(Boolean).join('\n')); }
    // Research is reference data: risks, assumptions (as assumptions, never as requirements) and your own notes.
    const risks = blueprint.risks.filter(risk => risk.status === 'open' && (risk.componentIds.some(id => componentIds.has(id)) || explicit('risks').has(risk.id)));
    for (const risk of risks) use('risks', risk);
    push('Open risks', bullets(risks.map(risk => `${risk.title || 'Untitled risk'} (${label('severity', risk.severity).toLowerCase()})${hasText(risk.mitigation) ? ` — mitigation: ${clip(risk.mitigation, 600)}` : ''}`)));
    const assumptions = blueprint.assumptions.filter(entry => explicit('assumptions').has(entry.id) && entry.status !== 'invalid');
    for (const entry of assumptions) { use('assumptions', entry); cite(entry); }
    push('Assumptions (not confirmed facts)', bullets(assumptions.map(entry => `${clip(entry.statement, 600)} — ${label('assumptionStatus', entry.status).toLowerCase()}`)));
    for (const id of explicit('technologies')) if (technologies.get(id) && technologies.get(id).status !== 'rejected' && !stackIds.has(id)) { use('technologies', technologies.get(id)); cite(technologies.get(id)); push(`Technology: ${technologies.get(id).name}`, `${tech(id)}${hasText(technologies.get(id).reason) ? ` — ${clip(technologies.get(id).reason, 600)}` : ''}`); }
    for (const section of blueprint.customSections.filter(entry => explicit('customSections').has(entry.id) && !entry.notApplicable)) {
      use('customSections', section, section.title.trim() || 'Untitled section');
      const answers = blueprint.questions.filter(question => question.sectionId === section.id && hasText(blueprint.answers[question.id]))
        .map(question => `${clip(question.text, 300)} → ${clip(blueprint.answers[question.id], 1500)}`);
      push(`Notes: ${section.title.trim() || 'Untitled section'}`, [hasText(section.description) && clip(section.description, 1500), answers.length && bullets(answers)].filter(Boolean).join('\n'));
    }
    for (const id of explicit('sources')) evidence.add(id);
    const cited = [...evidence].map(id => sources.get(id)).filter(Boolean);
    for (const source of cited) use('sources', source, source.title || source.url || 'Source');
    push('Evidence (a saved link alone proves nothing)', bullets(cited.map(source => `${source.title || 'Untitled source'}${source.url ? ` <${source.url}>` : ''} — ${label('sourceVerification', source.verification).toLowerCase()}${source.accessedAt ? `, checked ${source.accessedAt}` : ''}${hasText(source.claim) ? `: ${clip(source.claim, 400)}` : ''}`)));

    // Conflicts with the design are shown, never resolved silently.
    const said = [item.title, item.description, item.acceptanceCriteria].join('\n');
    for (const entry of blueprint.technologies) if (entry.status === 'rejected' && mentions(said, entry.name)) warnings.push(`The task mentions ${entry.name}, which was rejected.`);
    for (const decision of blueprint.decisions) if (decision.status === 'accepted') for (const alternative of lines(decision.alternatives)) {
      if (mentions(said, alternative) && !mentions(decision.decision, alternative)) warnings.push(`The task mentions “${alternative}”, an alternative that ${decision.key} did not choose.`);
    }
    if (!lines(item.acceptanceCriteria).length) warnings.push('The task has no “done when” yet.');

    // The task's own words, exactly as written.
    const instruction = `# ${item.key} ${item.title || 'Untitled task'}\n\n${hasText(item.description) ? `## What to do\n${item.description}\n\n` : ''}${hasText(item.acceptanceCriteria) ? `## Done when\n${item.acceptanceCriteria}\n` : ''}`.trimEnd();
    const render = list => list.map(entry => `## ${entry.title}\n${entry.body}`).join('\n\n');
    const essential = blocks.filter(entry => !entry.optional);
    const size = instruction.length + render(essential).length;
    if (size > limit) return { itemId, key: item.key, title: item.title, instruction, context: '', included, omitted: [], warnings, tooLarge: true, size,
      error: `The essential context for ${item.key} is ${size.toLocaleString('en-US')} characters, over the ${limit.toLocaleString('en-US')} limit. Link fewer requirements or components, or split the task.` };
    const kept = [], omitted = [];
    let used = size;
    for (const entry of blocks) {
      if (!entry.optional) { kept.push(entry); continue; }
      const cost = entry.title.length + entry.body.length + 6;
      if (used + cost > limit) { omitted.push(entry.title); continue; }
      kept.push(entry); used += cost;
    }
    let context = render(kept);
    if (omitted.length) context += `\n\n## Left out for size\n${bullets(omitted)}`;
    return { itemId, key: item.key, title: item.title, instruction, context, included, omitted, warnings, tooLarge: false, size: instruction.length + context.length };
  }
  /** One execution-ready body: the task as written, then the context, clearly separated. */
  function taskBody(built, { projectName = '', itemId = built.itemId } = {}) {
    return `${built.instruction}\n\n---\n\n# Context from the Origin design\nReference material for this task, not further instructions.\n\n${built.context}\n\n---\nOrigin reference: ${built.key} (origin task ${itemId}) in ${projectName || 'the project'}. Created from Origin; review before starting an agent.`;
  }

  /**
   * What Suggest tasks sends to the split service: the design of one component, one layer, or the project's
   * requirements — built by the same context builder, never the whole blueprint. Missing choices stay open.
   */
  function suggestionBrief(blueprint, { componentId = '', layerId = '', projectName = '' } = {}) {
    const component = blueprint.components.find(entry => entry.id === componentId), layer = blueprint.layers.find(entry => entry.id === layerId);
    const inScope = component ? [component.id] : layer ? blueprint.components.filter(entry => entry.layerId === layer.id).map(entry => entry.id) : [];
    const requirementIds = blueprint.requirements.filter(entry => !component && !layer || entry.componentIds.some(id => inScope.includes(id))).map(entry => entry.id);
    const probe = { id: 'suggestion-scope', key: '', title: '', description: '', acceptanceCriteria: '', componentIds: component ? [component.id] : [], layerId: component ? '' : layer?.id || '',
      requirementIds, dependsOn: [], contextIds: [], milestoneId: '', workstream: '', status: 'planned', handoff: null, refinement: null, lostLinks: [] };
    const built = taskContext({ ...blueprint, items: [...blueprint.items, probe] }, probe.id, { projectName });
    const scope = component ? `the component “${component.name || 'Unnamed component'}”` : layer ? `the ${layer.name || 'unnamed'} layer` : 'the project’s requirements';
    const existing = blueprint.items.filter(item => { const home = taskHome(blueprint, item); return component ? home.componentId === component.id : layer ? home.layerId === layer.id : true; })
      .map(item => `- ${item.key} ${item.title || 'Untitled task'}`);
    return [`Plan implementation tasks for ${scope} in ${projectName || 'the project'}.`,
      'Use only the design below. Where a design choice is missing, add a task that decides it instead of choosing a technology or changing the architecture. Do not claim that the tasks cover the whole project.',
      existing.length ? `Tasks that already exist (do not repeat them):\n${existing.join('\n')}` : '', built.context].filter(Boolean).join('\n\n');
  }

  /** Where a task lives: its first component and that component's layer; otherwise its own layer; otherwise the project. */
  function taskHome(blueprint, item) {
    const component = blueprint.components.find(entry => entry.id === item.componentIds[0]);
    return component ? { componentId: component.id, layerId: component.layerId || '' } : { componentId: '', layerId: item.layerId || '' };
  }

  /** Item references used for navigation from issues and inspector rows. */
  const COLLECTION_SECTION = { requirements: 'requirements', components: 'architecture', connections: 'architecture', technologies: 'technology', dependencies: 'dependencies',
    decisions: 'decisions', assumptions: 'research', sources: 'research', risks: 'research', milestones: 'plan', items: 'plan' };
  function itemName(blueprint, collection, id) {
    const entry = blueprint[collection]?.find(item => item.id === id);
    if (!entry) return '';
    const name = entry.name || entry.title || entry.statement || entry.label || 'Untitled';
    return entry.key ? `${entry.key} ${name}` : name;
  }

  /**
   * Deterministic, explainable checks over stored records. Every result names its rule; nothing here
   * is inferred from free text. Human-entered and AI-suggested risks are passed through with their origin.
   */
  function issues(blueprint) {
    const found = [];
    const add = (rule, kind, title, target, { blocking = true, detail = '', action = '' } = {}) =>
      found.push({ id: `${rule}:${target?.id || target?.section || ''}:${found.length}`, rule, kind, origin: 'system', title, detail, action, blocking, target });
    const sources = byId(blueprint.sources);
    const target = (collection, id) => ({ section: COLLECTION_SECTION[collection], collection, id });
    if (!isStarted(blueprint)) return found;
    if (!blueprint.requirements.length) add('requirements-empty', 'missing', 'No requirements are defined yet.', { section: 'requirements' }, { action: 'Add the first requirement.' });
    if (!blueprint.components.length) add('components-empty', 'missing', 'No architecture components are defined yet.', { section: 'architecture' }, { action: 'Add the main components.' });
    for (const requirement of blueprint.requirements) {
      const name = itemName(blueprint, 'requirements', requirement.id);
      if (requirement.status === 'needs_decision') add('requirement-decision', 'unresolved', `${name} needs a decision.`, target('requirements', requirement.id));
      if (!lines(requirement.acceptanceCriteria).length) add('requirement-criteria', 'missing', `${name} has no “done when” yet.`, target('requirements', requirement.id), { action: 'Say how you will know it works.' });
    }
    const connected = new Set(blueprint.connections.flatMap(connection => [connection.from, connection.to]));
    for (const component of blueprint.components) {
      const name = component.name || 'Unnamed component';
      if (!hasText(component.purpose)) add('component-purpose', 'missing', `Component “${name}” has no purpose.`, target('components', component.id), { action: 'Describe its purpose.' });
      if (component.status === 'needs_decision') add('component-decision', 'unresolved', `Component “${name}” needs a decision.`, target('components', component.id));
      if (blueprint.components.length > 1 && !connected.has(component.id)) add('component-isolated', 'missing', `Component “${name}” has no connections.`, target('components', component.id), { blocking: false, action: 'Connect it or explain why it stands alone.' });
    }
    const used = new Set(blueprint.components.flatMap(component => component.technologyIds));
    const names = new Map();
    for (const technology of blueprint.technologies) {
      if (technology.status === 'rejected') continue;
      const name = `${technology.name || 'Unnamed technology'}${technology.version ? ` ${technology.version}` : ''}`;
      const state = verification(technology, sources);
      if (state === 'conflict') add('technology-conflict', 'conflict', `“${name}” has conflicting evidence.`, target('technologies', technology.id));
      else if (state === 'outdated') add('technology-outdated', 'unverified', `“${name}” is supported only by outdated evidence.`, target('technologies', technology.id), { blocking: false, action: 'Recheck the source.' });
      else if (state === 'unverified') add('technology-unverified', 'unverified', `“${name}” is selected without verified evidence.`, target('technologies', technology.id), { blocking: false, action: 'Link a verified source.' });
      if (blueprint.components.length && technology.status === 'selected' && !used.has(technology.id)) add('technology-unused', 'missing', `“${name}” is not used by any component.`, target('technologies', technology.id), { blocking: false, action: 'Link it to a component or reject it.' });
      const key = `technology:${technology.name.trim().toLowerCase()}`;
      if (technology.name.trim()) names.set(key, [...(names.get(key) || []), technology]);
    }
    for (const dependency of blueprint.dependencies) {
      const name = `${dependency.name || 'Unnamed dependency'}${dependency.version ? ` ${dependency.version}` : ''}`;
      const state = verification(dependency, sources);
      if (state === 'conflict') add('dependency-conflict', 'conflict', `Dependency “${name}” has conflicting evidence.`, target('dependencies', dependency.id));
      else if (state !== 'verified') add('dependency-unverified', 'unverified', `Dependency “${name}” is ${state === 'outdated' ? 'supported only by outdated evidence' : 'unverified'}.`, target('dependencies', dependency.id), { blocking: false, action: 'Link a verified source.' });
      const key = `dependency:${dependency.name.trim().toLowerCase()}`;
      if (dependency.name.trim()) names.set(key, [...(names.get(key) || []), dependency]);
    }
    for (const [key, list] of names) if (list.length > 1) {
      const collection = key.startsWith('technology:') ? 'technologies' : 'dependencies';
      add(`duplicate-${collection}`, 'conflict', `“${list[0].name.trim()}” is listed ${list.length} times in ${sectionTitle(blueprint, COLLECTION_SECTION[collection])}.`, target(collection, list[1].id), { action: 'Merge or remove the duplicate.' });
    }
    for (const decision of blueprint.decisions) {
      const name = itemName(blueprint, 'decisions', decision.id);
      if (decision.status === 'proposed') add('decision-proposed', 'unresolved', `${name} is still proposed.`, target('decisions', decision.id), { action: 'Accept or reject it.' });
      if (decision.status === 'accepted' && !hasText(decision.reason)) add('decision-reason', 'missing', `${name} is accepted without a recorded reason.`, target('decisions', decision.id), { action: 'Record the rationale.' });
      if (decision.status === 'superseded' && !decision.supersededBy) add('decision-replacement', 'missing', `${name} is superseded but does not name its replacement.`, target('decisions', decision.id), { blocking: false });
    }
    for (const source of blueprint.sources) {
      const name = source.title || source.url || 'Untitled source';
      if (source.verification === 'conflicting') add('source-conflict', 'conflict', `Source “${name}” conflicts with another claim.`, target('sources', source.id), { action: 'Resolve the conflict.' });
      if (source.verification === 'outdated') add('source-outdated', 'unverified', `Source “${name}” is outdated.`, target('sources', source.id), { blocking: false, action: 'Find a current source.' });
      if (source.verification === 'verified' && !source.accessedAt) add('source-date', 'missing', `Verified source “${name}” has no access date.`, target('sources', source.id), { blocking: false });
    }
    const planned = section => blueprint.areas.some(item => item.section === section);
    if (blueprint.requirements.some(item => item.type === 'security') && !planned('security')) add('security-plan', 'missing', 'Security requirements exist, but no security planning items are defined.', { section: 'security' });
    if (blueprint.requirements.length && !planned('testing')) add('testing-plan', 'missing', 'No testing strategy is defined.', { section: 'testing' }, { blocking: false, action: 'Plan at least one test area.' });
    for (const item of blueprint.areas) {
      if (item.status === 'needs_decision') add('area-decision', 'unresolved', `${label(item.section, item.area)}: “${item.title || 'Untitled'}” needs a decision.`, { section: item.section, collection: 'areas', id: item.id });
      if (item.section === 'deployment' && blueprint.components.length && !item.componentIds.length) add('deployment-components', 'missing', `Deployment item “${item.title || 'Untitled'}” is not linked to a component.`, { section: 'deployment', collection: 'areas', id: item.id }, { blocking: false });
    }
    // Implementation order: cycles and dependencies scheduled after their dependants.
    const items = byId(blueprint.items), milestoneIndex = new Map(blueprint.milestones.map((milestone, index) => [milestone.id, index]));
    const visiting = new Set(), done = new Set(), cyclic = new Set();
    const visit = (id, path) => {
      if (done.has(id)) return;
      if (visiting.has(id)) { for (const member of path.slice(path.indexOf(id))) cyclic.add(member); return; }
      visiting.add(id);
      for (const next of items.get(id)?.dependsOn || []) visit(next, [...path, next]);
      visiting.delete(id); done.add(id);
    };
    for (const item of blueprint.items) visit(item.id, [item.id]);
    for (const id of cyclic) add('plan-cycle', 'conflict', `${itemName(blueprint, 'items', id)} is part of a dependency cycle.`, target('items', id), { action: 'Remove one dependency in the cycle.' });
    for (const item of blueprint.items) for (const dependencyId of item.dependsOn) {
      const before = milestoneIndex.get(items.get(dependencyId)?.milestoneId), after = milestoneIndex.get(item.milestoneId);
      if (before !== undefined && after !== undefined && before > after) add('plan-order', 'conflict', `${itemName(blueprint, 'items', item.id)} depends on ${itemName(blueprint, 'items', dependencyId)}, which is scheduled in a later milestone.`, target('items', item.id), { action: 'Move one of the items.' });
    }
    for (const item of blueprint.items) for (const lost of item.lostLinks || []) add('task-link-missing', 'missing', `${itemName(blueprint, 'items', item.id)} lost its link to the removed component “${lost.name}”.`, target('items', item.id), { blocking: false, action: 'Relink it to a component or dismiss the note.' });
    for (const risk of blueprint.risks) if (risk.status === 'open') found.push({ id: `risk:${risk.id}`, rule: 'recorded', kind: risk.kind, origin: risk.origin, title: risk.title || 'Untitled risk',
      detail: risk.description, action: risk.mitigation, blocking: risk.kind !== 'risk' && risk.origin === 'human', severity: risk.severity, target: target('risks', risk.id) });
    return found;
  }

  /** Transparent completion indicators. Every value is a count of stored records; no scores. */
  function readiness(blueprint, found = issues(blueprint)) {
    const sources = byId(blueprint.sources);
    const count = (list, test) => list.filter(test).length;
    const activeTech = blueprint.technologies.filter(item => item.status === 'selected');
    const testingAreas = new Set(blueprint.areas.filter(item => item.section === 'testing' && item.status === 'defined').map(item => item.area));
    const handed = count(blueprint.items, item => item.handoff);
    const rows = [
      { id: 'requirements', label: 'Requirements', value: `${count(blueprint.requirements, item => lines(item.acceptanceCriteria).length > 0)} / ${blueprint.requirements.length} with done-when`, section: 'requirements' },
      { id: 'components', label: 'Components', value: `${count(blueprint.components, item => hasText(item.purpose))} / ${blueprint.components.length} described`, section: 'architecture' },
      { id: 'technologies', label: 'Technologies', value: `${count(activeTech, item => verification(item, sources) === 'verified')} / ${activeTech.length} verified`, section: 'technology' },
      { id: 'dependencies', label: 'Dependencies', value: `${count(blueprint.dependencies, item => verification(item, sources) === 'verified')} / ${blueprint.dependencies.length} verified`, section: 'dependencies' },
      { id: 'decisions', label: 'Decisions', value: `${count(blueprint.decisions, item => item.status === 'proposed')} unresolved`, section: 'decisions' },
      { id: 'assumptions', label: 'Assumptions', value: `${count(blueprint.assumptions, item => item.status === 'open')} open`, section: 'research' },
      { id: 'sources', label: 'Sources', value: `${count(blueprint.sources, item => item.verification !== 'verified')} not verified`, section: 'research' },
      { id: 'testing', label: 'Testing', value: `${plural(testingAreas.size, 'area')} defined`, section: 'testing' },
      { id: 'plan', label: 'Tasks', value: blueprint.items.length ? `${plural(blueprint.items.length, 'task')} · ${handed} in Kanban` : 'none yet', section: 'plan' },
    ];
    const blocking = found.filter(issue => issue.blocking);
    if (!isStarted(blueprint)) return { state: 'not_started', label: 'Not started', reasons: ['Describe the project to start its blueprint.'], rows, blocking };
    if (blocking.length) {
      const groups = [['conflict', 'conflict', 'conflicts'], ['unresolved', 'open decision', 'open decisions'], ['unverified', 'unverified technology or dependency', 'unverified technologies or dependencies'], ['missing', 'item with missing information', 'items with missing information']];
      const reasons = groups.map(([kind, one, many]) => [count(blocking, issue => issue.kind === kind), one, many]).filter(([total]) => total).map(([total, one, many]) => `${plural(total, one, many)} remain${total === 1 ? 's' : ''}.`);
      return { state: 'attention', label: 'Needs attention', reasons, rows, blocking };
    }
    if (!blueprint.items.length) return { state: 'decompose', label: 'Ready for task decomposition', reasons: ['Requirements, architecture and decisions have no blocking issues.'], rows, blocking };
    return { state: 'ready', label: 'Ready for implementation', reasons: [`${plural(blueprint.items.length, 'task')} planned; ${handed} in Kanban.`], rows, blocking };
  }

  /** Navigator state per section: decision required, attention, in progress, defined, not started or not applicable. */
  function sectionStates(blueprint, found = issues(blueprint)) {
    const states = {};
    const content = {
      vision: VISION.some(key => key !== 'architectureSummary' && hasText(blueprint.vision[key])), requirements: blueprint.requirements.length, architecture: blueprint.components.length,
      technology: blueprint.technologies.length, dependencies: blueprint.dependencies.length, research: blueprint.sources.length + blueprint.assumptions.length,
      decisions: blueprint.decisions.length, plan: blueprint.items.length + blueprint.milestones.length,
    };
    for (const section of Object.keys(AREAS)) content[section] = blueprint.areas.filter(item => item.section === section).length;
    const complete = {
      vision: ['problem', 'goal', 'users', 'inScope'].every(key => hasText(blueprint.vision[key])),
      requirements: blueprint.requirements.every(item => lines(item.acceptanceCriteria).length > 0), architecture: blueprint.components.every(item => hasText(item.purpose)),
      technology: blueprint.technologies.every(item => item.status !== 'candidate'), research: blueprint.assumptions.every(item => item.status !== 'open'),
      decisions: blueprint.decisions.every(item => item.status !== 'proposed'), plan: blueprint.items.length > 0,
    };
    for (const section of Object.keys(AREAS)) complete[section] = blueprint.areas.filter(item => item.section === section).every(item => item.status === 'defined');
    const ready = readiness(blueprint, found);
    // A custom section is complete when every question it asks has an answer.
    for (const custom of blueprint.customSections) {
      const asked = blueprint.questions.filter(question => question.scope === 'section' && question.sectionId === custom.id);
      const answered = asked.filter(question => hasText(blueprint.answers[question.id])).length;
      states[custom.id] = custom.notApplicable ? 'na' : !hasText(custom.description) && !answered ? 'empty' : answered === asked.length ? 'defined' : 'progress';
    }
    for (const { id } of SECTIONS) {
      const related = found.filter(issue => issue.target?.section === id && id !== 'overview');
      if (id === 'overview') states[id] = { not_started: 'empty', attention: 'attention', decompose: 'defined', ready: 'defined' }[ready.state];
      else if (blueprint.sections[id]?.notApplicable) states[id] = 'na';
      else if (related.some(issue => issue.kind === 'conflict')) states[id] = 'attention';
      else if (related.some(issue => issue.kind === 'unresolved')) states[id] = 'decision';
      else if (related.some(issue => issue.blocking)) states[id] = 'attention';
      else if (!content[id]) states[id] = 'empty';
      else states[id] = complete[id] ? 'defined' : 'progress';
    }
    return states;
  }
  const SECTION_STATE = { defined: ['✓', 'Defined'], progress: ['●', 'In progress'], attention: ['!', 'Needs attention'], decision: ['?', 'Decision required'], empty: ['○', 'Not started'], na: ['–', 'Not applicable'] };

  // ---- Handoffs: targeted context only, never the whole blueprint ----

  const clip = (text, max = 4000) => { const value = String(text || '').trim(); return value.length > max ? `${value.slice(0, max)}…` : value; };
  const block = (title, body) => (hasText(body) ? `## ${title}\n${body.trim()}\n\n` : '');
  const bullets = list => list.filter(hasText).map(entry => `- ${entry}`).join('\n');
  const criteria = text => bullets(lines(text).map(line => clip(line, 600)));

  function componentLine(blueprint, component) {
    const tech = component.technologyIds.map(id => blueprint.technologies.find(item => item.id === id)?.name).filter(Boolean);
    return `${component.name || 'Unnamed component'} (${label('componentType', component.type)})${hasText(component.purpose) ? `: ${clip(component.purpose, 400)}` : ''}${tech.length ? ` [${tech.join(', ')}]` : ''}`;
  }
  function decisionLines(blueprint, test) {
    return blueprint.decisions.filter(decision => decision.status === 'accepted' && test(decision))
      .map(decision => `${decision.key} ${decision.title}: ${clip(decision.decision, 600)}${hasText(decision.reason) ? ` (reason: ${clip(decision.reason, 400)})` : ''}`);
  }
  function evidenceLines(blueprint, entity) {
    return (entity.sourceIds || []).map(id => blueprint.sources.find(source => source.id === id)).filter(Boolean)
      .map(source => `${source.title || 'Untitled source'}${source.url ? ` <${source.url}>` : ''} — ${label('sourceVerification', source.verification)}${source.accessedAt ? `, accessed ${source.accessedAt}` : ''}`);
  }
  // Testing plans carry into handoffs through their links to requirements and components.
  function testLines(blueprint, requirementIds, componentIds) {
    return blueprint.areas.filter(item => item.section === 'testing' && (item.requirementIds.some(id => requirementIds.includes(id)) || item.componentIds.some(id => componentIds.includes(id))))
      .map(item => `${label('testing', item.area)}: ${item.title || 'Untitled'}${hasText(item.description) ? ` — ${clip(item.description, 400)}` : ''}`);
  }
  function guardrails(blueprint) {
    return block('Project constraints', clip(blueprint.vision.constraints, 1500)) + block('Out of scope', clip(blueprint.vision.outOfScope, 1500));
  }

  /** Compose prefill for one selected item. Compose still waits for an explicit Generate. */
  function composeSpec(blueprint, collection, id, projectName = '') {
    const entry = blueprint[collection]?.find(item => item.id === id);
    if (!entry) return null;
    const components = ids => ids.map(componentId => blueprint.components.find(item => item.id === componentId)).filter(Boolean);
    const header = `# Implementation specification from Origin\nProject: ${projectName || 'Unnamed project'}${hasText(blueprint.vision.summary) ? ` — ${clip(blueprint.vision.summary, 400)}` : ''}\nOrigin reference: ${itemName(blueprint, collection, id)} (origin ${collection.replace(/s$/, '')} ${id})\nThis is targeted context for one blueprint item, not the whole blueprint.\n`;
    let body = '', task = 'feature', title = itemName(blueprint, collection, id);
    if (collection === 'requirements') {
      task = { security: 'security', performance: 'performance' }[entry.type] || 'feature';
      const related = components(entry.componentIds);
      body = block('Requirement', `${entry.key} ${entry.title}\nType: ${label('requirementType', entry.type)} · Priority: ${label('priority', entry.priority)} · Status: ${label('itemStatus', entry.status)}\n\n${clip(entry.description)}`)
        + block('Acceptance criteria', criteria(entry.acceptanceCriteria))
        + block('Related components', bullets(related.map(component => componentLine(blueprint, component))))
        + block('Accepted decisions to respect', bullets(decisionLines(blueprint, decision => decision.requirementIds.includes(id) || decision.componentIds.some(componentId => entry.componentIds.includes(componentId)))))
        + block('Planned tests', bullets(testLines(blueprint, [id], [])))
        + block('Evidence', bullets(evidenceLines(blueprint, entry)));
    } else if (collection === 'components') {
      task = 'build';
      const out = blueprint.connections.filter(connection => connection.from === id), into = blueprint.connections.filter(connection => connection.to === id);
      const name = componentId => blueprint.components.find(item => item.id === componentId)?.name || 'Unnamed component';
      const via = connection => [connection.label, connection.protocol].filter(hasText).join(', ');
      body = block('Component', `${componentLine(blueprint, entry)}\nStatus: ${label('itemStatus', entry.status)}`)
        + block('Responsibilities', clip(entry.responsibilities)) + block('Interfaces', clip(entry.interfaces)) + block('Data handled', clip(entry.dataHandled))
        + block('Depends on', bullets(out.map(connection => `${name(connection.to)}${via(connection) ? ` (${via(connection)})` : ''}`)))
        + block('Used by', bullets(into.map(connection => `${name(connection.from)}${via(connection) ? ` (${via(connection)})` : ''}`)))
        + block('Requirements it serves', bullets(blueprint.requirements.filter(item => item.componentIds.includes(id)).map(item => `${item.key} ${item.title}${lines(item.acceptanceCriteria).length ? ` — accepted when: ${lines(item.acceptanceCriteria).map(line => clip(line, 300)).join('; ')}` : ''}`)))
        + block('Dependencies', bullets(blueprint.dependencies.filter(item => item.requiredBy.includes(id)).map(item => `${item.name}${item.version ? ` ${item.version}` : ''} (${label('dependencyType', item.type)})`)))
        + block('Planned security, testing and deployment', bullets(blueprint.areas.filter(item => item.componentIds.includes(id)).map(item => `${sectionLabel(item.section)} · ${label(item.section, item.area)}: ${item.title}${hasText(item.description) ? ` — ${clip(item.description, 300)}` : ''}`)))
        + block('Accepted decisions to respect', bullets(decisionLines(blueprint, decision => decision.componentIds.includes(id))));
    } else if (collection === 'decisions') {
      task = 'architecture';
      const names = (list, ids) => ids.map(itemId => itemName(blueprint, list, itemId)).filter(Boolean);
      body = block('Decision record', `${entry.key} ${entry.title}\nStatus: ${label('decisionStatus', entry.status)}${entry.date ? ` · ${entry.date}` : ''}`)
        + block('Context', clip(entry.context)) + block('Decision', clip(entry.decision)) + block('Alternatives considered', clip(entry.alternatives))
        + block('Reason', clip(entry.reason)) + block('Consequences', clip(entry.consequences))
        + block('Applies to', bullets([...names('components', entry.componentIds), ...names('technologies', entry.technologyIds), ...names('requirements', entry.requirementIds), ...names('dependencies', entry.dependencyIds)]))
        + block('Evidence', bullets(evidenceLines(blueprint, entry)))
        + (entry.status === 'accepted' ? '## Rule\nThis decision is accepted. Do not replace it without a new decision record.\n' : '');
    } else if (collection === 'milestones') {
      task = 'build';
      const items = orderItems(blueprint, blueprint.items.filter(item => item.milestoneId === id).map(item => item.id)).map(itemId => blueprint.items.find(item => item.id === itemId));
      body = block('Milestone', `${entry.title}\n\n${clip(entry.goal)}`) + block('Definition of done', criteria(entry.definitionOfDone))
        + block('Items in order', items.map((item, index) => `${index + 1}. ${item.key} ${item.title}${lines(item.acceptanceCriteria).length ? `\n   Accepted when: ${lines(item.acceptanceCriteria).map(line => clip(line, 300)).join('; ')}` : ''}`).join('\n'));
    } else if (collection === 'items') {
      body = itemBody(blueprint, entry);
    } else return null;
    return { title, task, text: clip(`${header}\n${body}${guardrails(blueprint)}`, 100000) };
  }

  function itemBody(blueprint, item, { heading = true } = {}) {
    const milestone = blueprint.milestones.find(entry => entry.id === item.milestoneId);
    const requirements = item.requirementIds.map(id => blueprint.requirements.find(entry => entry.id === id)).filter(Boolean);
    const components = item.componentIds.map(id => blueprint.components.find(entry => entry.id === id)).filter(Boolean);
    const summary = `${item.workstream ? `Workstream: ${item.workstream}\n\n` : ''}${clip(item.description)}`;
    return (heading ? block('Work item', `${item.key} ${item.title}\n${summary}`) : `Implement ${item.key} ${item.title || 'Untitled item'}.\n\n${hasText(summary) ? `${summary.trim()}\n\n` : ''}`)
      + block('Acceptance criteria', criteria(item.acceptanceCriteria))
      + block('Requirements', requirements.map(entry => `- ${entry.key} ${entry.title}${lines(entry.acceptanceCriteria).length ? `\n${lines(entry.acceptanceCriteria).map(line => `  - ${clip(line, 300)}`).join('\n')}` : ''}`).join('\n'))
      + block('Components', bullets(components.map(component => componentLine(blueprint, component))))
      + block('Depends on', bullets(item.dependsOn.map(id => itemName(blueprint, 'items', id))))
      + block('Accepted decisions to respect', bullets(decisionLines(blueprint, decision => decision.componentIds.some(id => item.componentIds.includes(id)) || decision.requirementIds.some(id => item.requirementIds.includes(id)))))
      + block('Planned tests', bullets(testLines(blueprint, item.requirementIds, item.componentIds)))
      + (milestone ? block(`Milestone: ${milestone.title}`, `Definition of done:\n${criteria(milestone.definitionOfDone) || '- Not recorded'}`) : '');
  }

  /** Dependencies first, then milestone order, then plan order. Cycles are reported as conflicts; their order is unspecified. */
  function orderItems(blueprint, selected) {
    const items = byId(blueprint.items), wanted = new Set(selected), milestoneIndex = new Map(blueprint.milestones.map((milestone, index) => [milestone.id, index]));
    const rank = item => [milestoneIndex.get(item.milestoneId) ?? blueprint.milestones.length, blueprint.items.indexOf(item)];
    const sorted = blueprint.items.filter(item => wanted.has(item.id)).sort((a, b) => { const [x1, y1] = rank(a), [x2, y2] = rank(b); return x1 - x2 || y1 - y2; });
    const result = [], placed = new Set(), visiting = new Set();
    const place = item => {
      if (placed.has(item.id) || visiting.has(item.id)) return;
      visiting.add(item.id);
      for (const id of item.dependsOn) if (wanted.has(id)) place(items.get(id));
      visiting.delete(item.id); placed.add(item.id); result.push(item.id);
    };
    for (const item of sorted) place(item);
    return result;
  }



  // ---- Origin Research: what can be researched, and bounded read-only context for one scope ----

  // Fields shown to research agents, per collection: [field, enum name for a label]. Text only; positions and layout never.
  const RESEARCH_FIELDS = {
    requirements: [['title'], ['type', 'requirementType'], ['priority', 'priority'], ['status', 'itemStatus'], ['description'], ['acceptanceCriteria']],
    components: [['name'], ['type', 'componentType'], ['status', 'itemStatus'], ['purpose'], ['responsibilities'], ['interfaces'], ['dataHandled'], ['notes']],
    technologies: [['name'], ['category', 'techCategory'], ['status', 'techStatus'], ['version'], ['purpose'], ['reason'], ['alternatives']],
    dependencies: [['name'], ['type', 'dependencyType'], ['version'], ['notes']],
    decisions: [['title'], ['status', 'decisionStatus'], ['context'], ['decision'], ['alternatives'], ['reason'], ['consequences']],
    assumptions: [['statement'], ['status', 'assumptionStatus'], ['reason'], ['impact']],
    risks: [['title'], ['kind', 'riskKind'], ['severity', 'severity'], ['status', 'riskStatus'], ['description'], ['mitigation']],
    sources: [['title'], ['type', 'sourceType'], ['verification', 'sourceVerification'], ['url'], ['accessedAt'], ['claim']],
    layers: [['name'], ['description'], ['constraints']],
    areas: [['title'], ['status', 'itemStatus'], ['description']],
    milestones: [['title'], ['goal'], ['definitionOfDone']],
    items: [['title'], ['description'], ['acceptanceCriteria']],
  };
  const RESEARCH_NOUN = { requirements: 'requirement', components: 'component', technologies: 'technology', dependencies: 'dependency', decisions: 'decision', assumptions: 'assumption',
    risks: 'risk', sources: 'source', layers: 'layer', areas: 'planning answer', milestones: 'milestone', items: 'task', connections: 'connection' };
  const RESEARCH_GROUPS = [['components', 'Building blocks'], ['requirements', 'Requirements'], ['technologies', 'Technologies'], ['dependencies', 'Dependencies'],
    ['decisions', 'Decisions'], ['assumptions', 'Assumptions'], ['risks', 'Risks'], ['layers', 'Layers']];
  // The records each built-in section is made of.
  const SECTION_RECORDS = { requirements: ['requirements'], architecture: ['layers', 'components'], technology: ['technologies'], dependencies: ['dependencies'],
    research: ['assumptions', 'sources', 'risks'], decisions: ['decisions'], plan: ['milestones', 'items'] };
  const recordTitle = (blueprint, collection, entry) => itemName(blueprint, collection, entry.id) || entry.title || entry.name || entry.statement || 'Untitled';

  /** Everything the person can choose to research, from stable IDs and in this project's own words. */
  function researchTargets(blueprint) {
    const options = [{ value: { kind: 'project' }, label: 'Whole project' }];
    for (const phase of phaseList(blueprint)) for (const id of phase.sections) {
      const skipped = blueprint.sections[id]?.notApplicable || blueprint.customSections.find(entry => entry.id === id)?.notApplicable;
      options.push({ value: { kind: 'section', id }, label: `${phase.label} › ${sectionTitle(blueprint, id)}${skipped ? ' (not needed)' : ''}`, group: 'Sections' });
    }
    for (const [collection, group] of RESEARCH_GROUPS) for (const entry of blueprint[collection].slice(0, 200)) {
      const open = (collection === 'decisions' && entry.status === 'proposed') || entry.status === 'needs_decision' || (collection === 'assumptions' && entry.status === 'open');
      options.push({ value: { kind: 'record', collection, id: entry.id }, label: `${clip(recordTitle(blueprint, collection, entry), 80)}${open ? ' (open)' : ''}`, group });
    }
    for (const key of VISION) options.push({ value: { kind: 'question', key: `vision:${key}` }, label: clip(questionText(blueprint, `vision:${key}`, VISION_QUESTIONS[key]), 90), group: 'Questions' });
    for (const question of blueprint.questions.filter(entry => entry.scope === 'section')) options.push({ value: { kind: 'question', key: `question:${question.id}` }, label: `${sectionTitle(blueprint, question.sectionId)}: ${clip(question.text, 80)}`, group: 'Questions' });
    for (const [section, topics] of Object.entries(AREAS)) {
      if (blueprint.sections[section]?.notApplicable) continue;
      for (const [area, name] of topics) options.push({ value: { kind: 'question', key: `topic:${section}:${area}` }, label: `${sectionTitle(blueprint, section)}: ${clip(questionText(blueprint, `topic:${section}:${area}`, name), 70)}`, group: 'Questions' });
    }
    for (const component of blueprint.components.slice(0, 50)) for (const question of blueprint.questions.filter(entry => entry.scope === 'component')) {
      options.push({ value: { kind: 'question', key: `component:${component.id}:${question.id}` }, label: `${clip(component.name || 'Unnamed component', 40)}: ${clip(question.text, 60)}`, group: 'Questions' });
    }
    return options;
  }

  /** One record as research context: a stable ID tag, its text fields, and the names of what it links to. */
  function researchRecord(blueprint, collection, entry, max = 1500) {
    const name = (list, ids) => (ids || []).map(id => recordTitle(blueprint, list, blueprint[list].find(item => item.id === id) || { id })).filter(Boolean);
    const lines2 = [`[${collection} ${entry.id}] ${RESEARCH_NOUN[collection] || collection}: ${clip(recordTitle(blueprint, collection, entry), 200)}`];
    for (const [field, enumName] of RESEARCH_FIELDS[collection] || []) {
      const value = entry[field];
      if (!hasText(value) || ['title', 'name'].includes(field)) continue;
      lines2.push(`  ${field}: ${enumName ? label(enumName, value) : clip(value, max)}`);
    }
    const links = [['technologyIds', 'technologies', 'technologies'], ['componentIds', 'components', 'components'], ['requirementIds', 'requirements', 'requirements'],
      ['requiredBy', 'components', 'required by'], ['dependsOn', collection === 'items' ? 'items' : 'dependencies', 'depends on'], ['dependencyIds', 'dependencies', 'dependencies']];
    for (const [field, list, title] of links) { const names = name(list, entry[field]); if (names.length) lines2.push(`  ${title}: ${names.join(', ')}`); }
    if (entry.layerId) lines2.push(`  layer: ${recordTitle(blueprint, 'layers', blueprint.layers.find(layer => layer.id === entry.layerId) || { id: entry.layerId })}`);
    if (collection === 'items' && entry.milestoneId) lines2.push(`  milestone: ${recordTitle(blueprint, 'milestones', blueprint.milestones.find(item => item.id === entry.milestoneId) || { id: entry.milestoneId })}`);
    if (collection === 'components') for (const question of blueprint.questions.filter(item => item.scope === 'component' && hasText(entry.answers?.[item.id]))) lines2.push(`  [question ${question.id}] ${clip(question.text, 200)} → ${clip(entry.answers[question.id], max)}`);
    return lines2.join('\n');
  }

  /** A section's own content: its records, topic answers and questions with their answers. */
  function researchSection(blueprint, id, { brief = false } = {}) {
    const custom = blueprint.customSections.find(entry => entry.id === id), out = [];
    const notNeeded = blueprint.sections[id]?.notApplicable || custom?.notApplicable;
    out.push(`[section ${id}] ${sectionTitle(blueprint, id)}${notNeeded ? ' — marked as not needed for this project' : ''}`);
    if (custom && hasText(custom.description)) out.push(`  description: ${clip(custom.description, 1500)}`);
    if (!custom && QUESTIONS[id]) out.push(`  guiding question: ${questionText(blueprint, `section:${id}`, QUESTIONS[id])}`);
    if (id === 'vision') for (const key of VISION.filter(key => !brief || hasText(blueprint.vision[key]))) out.push(`  [vision ${key}] ${questionText(blueprint, `vision:${key}`, VISION_QUESTIONS[key])} → ${hasText(blueprint.vision[key]) ? clip(blueprint.vision[key], brief ? 300 : 2000) : '(no answer yet)'}`);
    for (const collection of SECTION_RECORDS[id] || []) {
      const entries = blueprint[collection];
      if (brief) { if (entries.length) out.push(`  ${collection} (${entries.length}): ${entries.slice(0, 30).map(entry => `${clip(recordTitle(blueprint, collection, entry), 60)} [${entry.id}]`).join('; ')}`); }
      else for (const entry of entries) out.push(researchRecord(blueprint, collection, entry));
    }
    if (id === 'architecture' && !brief) for (const connection of blueprint.connections) {
      const from = blueprint.components.find(entry => entry.id === connection.from), to = blueprint.components.find(entry => entry.id === connection.to);
      out.push(`  [connections ${connection.id}] connection: ${from?.name || 'Unnamed'} → ${to?.name || 'Unnamed'}${[connection.label, connection.protocol].filter(hasText).length ? ` (${[connection.label, connection.protocol].filter(hasText).join(', ')})` : ''}`);
    }
    if (AREAS[id]) {
      const open = [];
      for (const [area, name] of AREAS[id]) {
        const answers = blueprint.areas.filter(entry => entry.section === id && entry.area === area);
        const topic = questionText(blueprint, `topic:${id}:${area}`, name);
        if (!answers.length) { open.push(`${topic} [${id}:${area}]`); continue; }
        out.push(`  [topic ${id}:${area}] ${topic} → ${answers.map(entry => `${clip(entry.title, 200)}${hasText(entry.description) && !brief ? ` — ${clip(entry.description, 1000)}` : ''} [areas ${entry.id}]`).join('; ')}`);
      }
      // Unanswered topics share one line: their names and stable topic IDs, without repeating "no answer".
      if (open.length && !brief) out.push(`  unanswered topics: ${open.join('; ')}`);
    }
    for (const question of blueprint.questions.filter(entry => entry.scope === 'section' && entry.sectionId === id)) {
      out.push(`  [question ${question.id}] ${clip(question.text, 300)} → ${hasText(blueprint.answers[question.id]) ? clip(blueprint.answers[question.id], brief ? 300 : 2000) : '(no answer yet)'}`);
    }
    return out.join('\n');
  }

  /**
   * Read-only context for one research scope, built from stable IDs in the project's own words. The project's
   * purpose, scope and constraints always come first and are never cut; the focus of the scope comes next; the rest
   * of the blueprint is added in brief form while it fits. Returns { text, label, size, omitted }.
   */
  function researchContext(blueprint, scope = { kind: 'project' }, { projectName = '', limit = 24000 } = {}) {
    const vision = blueprint.vision, blocks = [], push = (title, body, optional = true) => { if (hasText(body)) blocks.push({ title, body: body.trim(), optional }); };
    push('Project', [`${projectName || 'Unnamed project'}`, hasText(blueprint.idea) && `Idea: ${clip(blueprint.idea, 2000)}`,
      ...['summary', 'problem', 'goal', 'users', 'successCriteria'].filter(key => hasText(vision[key])).map(key => `${questionText(blueprint, `vision:${key}`, VISION_QUESTIONS[key])} ${clip(vision[key], 1200)}`)].filter(Boolean).join('\n'), false);
    push('In scope', vision.inScope, false); push('Out of scope', vision.outOfScope, false); push('Constraints (keep them)', vision.constraints, false);
    let label2 = 'the whole project';
    const sectionIds = phaseList(blueprint).flatMap(phase => phase.sections);
    if (scope.kind === 'section' && sectionIds.includes(scope.id)) {
      label2 = `the section “${sectionTitle(blueprint, scope.id)}”`;
      push('Focus: this section', scope.id === 'overview' ? sectionIds.filter(id => id !== 'overview').map(id => researchSection(blueprint, id, { brief: true })).join('\n') : researchSection(blueprint, scope.id), false);
    } else if (scope.kind === 'record' && blueprint[scope.collection]?.some(entry => entry.id === scope.id)) {
      const entry = blueprint[scope.collection].find(item => item.id === scope.id);
      label2 = `the ${RESEARCH_NOUN[scope.collection] || 'record'} “${clip(recordTitle(blueprint, scope.collection, entry), 80)}”`;
      push('Focus: this record', researchRecord(blueprint, scope.collection, entry, 4000), false);
      // One hop: what this record links to and what links to it.
      const near = [];
      for (const [collection] of Object.entries(RESEARCH_FIELDS)) for (const other of blueprint[collection] || []) {
        if (other === entry) continue;
        const linksOut = ['technologyIds', 'componentIds', 'requirementIds', 'requiredBy', 'dependsOn', 'dependencyIds'].some(field => (entry[field] || []).includes(other.id)) || entry.layerId === other.id;
        const linksIn = ['technologyIds', 'componentIds', 'requirementIds', 'requiredBy', 'dependsOn', 'dependencyIds'].some(field => (other[field] || []).includes(entry.id)) || other.layerId === entry.id;
        if (linksOut || linksIn) near.push(researchRecord(blueprint, collection, other, 600));
      }
      if (scope.collection === 'components') for (const connection of blueprint.connections.filter(item => item.from === entry.id || item.to === entry.id)) {
        const other = blueprint.components.find(item => item.id === (connection.from === entry.id ? connection.to : connection.from));
        near.push(`connection ${connection.from === entry.id ? '→' : '←'} ${other?.name || 'Unnamed'}${[connection.label, connection.protocol].filter(hasText).length ? ` (${[connection.label, connection.protocol].filter(hasText).join(', ')})` : ''}`);
      }
      push('Linked records', near.join('\n'));
    } else if (scope.kind === 'question') {
      const [kind, a, b] = scope.key.split(':');
      let focus = '';
      if (kind === 'vision' && VISION.includes(a)) { label2 = `the question “${questionText(blueprint, scope.key, VISION_QUESTIONS[a])}”`; focus = `[vision ${a}] ${questionText(blueprint, scope.key, VISION_QUESTIONS[a])} → ${hasText(vision[a]) ? vision[a] : '(no answer yet)'}`; }
      else if (kind === 'topic' && AREAS[a]?.some(([area]) => area === b)) {
        const name = questionText(blueprint, scope.key, label(a, b));
        label2 = `the topic “${name}” in ${sectionTitle(blueprint, a)}`;
        const answers = blueprint.areas.filter(entry => entry.section === a && entry.area === b);
        focus = [`[topic ${a}:${b}] ${name} (section ${sectionTitle(blueprint, a)})`, ...(answers.length ? answers.map(entry => researchRecord(blueprint, 'areas', entry, 2000)) : ['(no answer yet)'])].join('\n');
      } else if (kind === 'question' && blueprint.questions.some(entry => entry.id === a && entry.scope === 'section')) {
        const question = blueprint.questions.find(entry => entry.id === a);
        label2 = `the question “${clip(question.text, 80)}”`;
        focus = `[question ${a}] ${question.text} (section ${sectionTitle(blueprint, question.sectionId)}) → ${hasText(blueprint.answers[a]) ? blueprint.answers[a] : '(no answer yet)'}`;
        push('Its section', researchSection(blueprint, question.sectionId, { brief: true }));
      } else if (kind === 'component' && blueprint.components.some(entry => entry.id === a) && blueprint.questions.some(entry => entry.id === b && entry.scope === 'component')) {
        const component = blueprint.components.find(entry => entry.id === a), question = blueprint.questions.find(entry => entry.id === b);
        label2 = `“${clip(question.text, 60)}” for ${component.name || 'a component'}`;
        focus = `[component ${a}] [question ${b}] ${question.text} → ${hasText(component.answers?.[b]) ? component.answers[b] : '(no answer yet)'}`;
        push('The component', researchRecord(blueprint, 'components', component, 2000));
      }
      push('Focus: this question', focus, false);
    }
    // Accepted decisions and the selected stack apply everywhere; then the rest of the blueprint in brief.
    push('Accepted decisions (keep them)', bullets(blueprint.decisions.filter(entry => entry.status === 'accepted').map(entry => `${entry.key} ${entry.title}: ${clip(entry.decision, 500)} [decisions ${entry.id}]`)));
    push('Selected technologies', bullets(blueprint.technologies.filter(entry => entry.status === 'selected').map(entry => `${entry.name}${entry.version ? ` ${entry.version}` : ''} [technologies ${entry.id}]`)));
    push('Open points found by Origin’s checks', bullets(issues(blueprint).slice(0, 40).map(issue => `${issue.title}${issue.target?.id ? ` [${issue.target.collection} ${issue.target.id}]` : issue.target?.section ? ` [section ${issue.target.section}]` : ''}`)));
    if (scope.kind !== 'project') push('The rest of the blueprint (brief)', sectionIds.filter(id => id !== 'overview' && !(scope.kind === 'section' && scope.id === id)).map(id => researchSection(blueprint, id, { brief: true })).join('\n'));
    else push('The blueprint', sectionIds.filter(id => id !== 'overview').map(id => researchSection(blueprint, id, { brief: blueprint.components.length + blueprint.requirements.length + blueprint.technologies.length > 60 })).join('\n'));
    // Required blocks first, then optional blocks in order while they fit.
    let text = '', omitted = [];
    for (const entry of blocks.filter(entry => !entry.optional)) text += `## ${entry.title}\n${entry.body}\n\n`;
    if (text.length > limit) text = `${text.slice(0, limit - 40)}\n…(cut to the size limit)\n`;
    for (const entry of blocks.filter(entry => entry.optional)) {
      const part = `## ${entry.title}\n${entry.body}\n\n`;
      if (text.length + part.length <= limit) text += part; else omitted.push(entry.title);
    }
    if (omitted.length) text += `## Left out for size\n${bullets(omitted)}\n`;
    return { text: text.trim(), label: label2, size: text.length, omitted };
  }

  // New-record defaults, shared by the Origin page (quick add) and research suggestions.
  const today = () => new Date().toLocaleDateString('en-CA');
  const RECORD_DEFAULTS = {
    requirements: title => ({ title, description: '', type: 'functional', priority: 'should', status: 'draft', acceptanceCriteria: '', componentIds: [], sourceIds: [] }),
    components: name => ({ name, type: 'service', purpose: '', responsibilities: '', technologyIds: [], interfaces: '', dataHandled: '', status: 'draft', notes: '', sourceIds: [], x: null, y: null, layerId: '', answers: {} }),
    technologies: name => ({ name, category: 'other', purpose: '', version: '', status: 'candidate', reason: '', alternatives: '', sourceIds: [] }),
    dependencies: name => ({ name, type: 'package', version: '', requiredBy: [], dependsOn: [], sourceIds: [], notes: '' }),
    decisions: title => ({ title, context: '', decision: '', alternatives: '', reason: '', consequences: '', status: 'proposed', date: today(), supersededBy: '', componentIds: [], technologyIds: [], requirementIds: [], dependencyIds: [], sourceIds: [] }),
    assumptions: statement => ({ statement, reason: '', impact: '', status: 'open', decisionId: '', sourceIds: [] }),
    sources: title => ({ title, url: '', type: 'documentation', claim: '', accessedAt: today(), verification: 'unverified', notes: '' }),
    risks: title => ({ title, description: '', kind: 'risk', severity: 'medium', mitigation: '', status: 'open', componentIds: [] }),
    milestones: title => ({ title, goal: '', definitionOfDone: '' }),
    items: title => ({ milestoneId: '', workstream: '', title, description: '', acceptanceCriteria: '', dependsOn: [], requirementIds: [], componentIds: [], layerId: '', contextIds: [], status: 'planned', handoff: null, refinement: null, lostLinks: [] }),
    layers: name => ({ name, description: '', technologyIds: [], constraints: '' }),
    areas: (title, section, area) => ({ section, area, title, description: '', status: 'defined', componentIds: [], requirementIds: [], technologyIds: [], baseResourceIds: [] }),
    connections: () => ({ from: '', to: '', label: '', protocol: '', notes: '' }),
  };
  // Relationships a suggestion may set: field → the collection it points to. Single links hold one ID.
  const LINKS = {
    components: { technologyIds: 'technologies', layerId: 'layers' },
    requirements: { componentIds: 'components' },
    dependencies: { requiredBy: 'components', dependsOn: 'dependencies' },
    decisions: { componentIds: 'components', technologyIds: 'technologies', requirementIds: 'requirements', dependencyIds: 'dependencies' },
    risks: { componentIds: 'components' },
    layers: { technologyIds: 'technologies' },
    items: { componentIds: 'components', requirementIds: 'requirements', dependsOn: 'items', milestoneId: 'milestones', layerId: 'layers' },
    connections: { from: 'components', to: 'components' },
    areas: { componentIds: 'components', requirementIds: 'requirements', technologyIds: 'technologies' },
  };
  const SINGLE_LINKS = new Set(['layerId', 'milestoneId', 'from', 'to']);
  const REF = /^@[A-Za-z0-9_.-]{1,60}$/;

  // ---- Origin Research suggestions: validated against the blueprint by stable IDs, applied only by the person ----
  // Fields a suggestion may set, per collection: a maximum length, an enum name, or 'url'. Links, keys and
  // positions are never set by a suggestion, and a source can never be marked verified by one.
  const SUGGEST_FIELDS = {
    requirements: { title: NAME, description: TEXT, acceptanceCriteria: TEXT, type: 'requirementType', priority: 'priority' },
    components: { name: NAME, type: 'componentType', purpose: TEXT, responsibilities: TEXT, interfaces: TEXT, dataHandled: TEXT, notes: TEXT },
    technologies: { name: NAME, category: 'techCategory', status: 'techStatus', version: 80, purpose: TEXT, reason: TEXT, alternatives: TEXT },
    dependencies: { name: NAME, type: 'dependencyType', version: 80, notes: TEXT },
    decisions: { title: NAME, status: 'decisionStatus', context: TEXT, decision: TEXT, alternatives: TEXT, reason: TEXT, consequences: TEXT },
    assumptions: { statement: 2000, status: 'assumptionStatus', reason: TEXT, impact: TEXT },
    risks: { title: NAME, kind: 'riskKind', severity: 'severity', status: 'riskStatus', description: TEXT, mitigation: TEXT },
    sources: { title: NAME, type: 'sourceType', url: 'url', claim: 4000, notes: TEXT },
    layers: { name: 80, description: 2000, constraints: TEXT },
    areas: { title: NAME, description: TEXT },
    milestones: { title: NAME, goal: TEXT, definitionOfDone: TEXT },
    items: { title: NAME, description: TEXT, acceptanceCriteria: TEXT, workstream: 80 },
    connections: { label: 80, protocol: 80, notes: 2000 },
  };
  // New records research may suggest, in the order a batch applies them (what others point to comes first).
  const SUGGEST_ADD = ['layers', 'technologies', 'components', 'requirements', 'dependencies', 'milestones', 'items', 'decisions', 'assumptions', 'risks', 'sources', 'connections'];
  const NAME_FIELD = { components: 'name', technologies: 'name', dependencies: 'name', assumptions: 'statement', layers: 'name' };
  const nameField = collection => NAME_FIELD[collection] || 'title';
  class SuggestionError extends Error {}
  const reject = message => { throw new SuggestionError(message); };
  /** One field value, checked like the blueprint itself checks it. Enum labels are accepted for their IDs. */
  function suggestionValue(collection, field, value) {
    const rule = SUGGEST_FIELDS[collection]?.[field];
    if (rule === undefined) reject(`${collection}.${field} cannot be suggested.`);
    if (typeof value !== 'string') reject('A suggested value must be text.');
    const text = value.trim();
    if (rule === 'url') { if (text && !/^https?:\/\/[^\s/@]+(?:\/[^\s]*)?$/i.test(text)) reject('A source URL must be an http(s) address without credentials.'); return text; }
    if (typeof rule === 'string') {
      const found = ENUMS[rule].find(([id, name]) => id === text || name.toLowerCase() === text.toLowerCase());
      if (!found) reject(`“${clip(text, 40)}” is not a valid ${field}.`);
      return found[0];
    }
    return text.length > rule ? `${text.slice(0, rule - 1)}…` : text;
  }
  /**
   * A relationship value: existing IDs of the right collection, or @references to new records suggested in the same
   * batch (`refs` maps a reference to its collection). Many-links are lists; layerId, milestoneId, from and to hold one.
   */
  function linkValue(blueprint, collection, field, value, refs) {
    const to = LINKS[collection]?.[field];
    if (!to) reject(`${collection}.${field} is not a relationship.`);
    const valid = id => (typeof id === 'string' && (REF.test(id) ? refs.get(id.slice(1)) === to : blueprint[to].some(entry => entry.id === id)));
    if (SINGLE_LINKS.has(field)) { if (!valid(value)) reject(`${field} must name one existing ${to.replace(/ies$/, 'y').replace(/s$/, '')}.`); return value; }
    if (!Array.isArray(value)) reject(`${field} must be a list of IDs.`);
    const ids = [...new Set(value)].slice(0, 50);
    if (!ids.length || !ids.every(valid)) reject(`${field} must list existing ${to} (or new ones from this answer).`);
    return ids;
  }
  /** A stable key for a suggestion's target: suggestions with the same key change the same field. */
  const researchTargetKey = target => target.kind === 'add' ? `add:${target.collection}` : [target.kind, target.collection, target.id, target.field, target.componentId, target.questionId, target.section, target.area].filter(Boolean).join(':');
  /** The current value of a target, '' when empty, or undefined when the target no longer exists. */
  function researchTargetValue(blueprint, target) {
    if (target.kind === 'idea') return blueprint.idea || '';
    if (target.kind === 'vision') return VISION.includes(target.field) ? blueprint.vision[target.field] || '' : undefined;
    if (target.kind === 'record') { const entry = blueprint[target.collection]?.find(item => item.id === target.id); return entry ? entry[target.field] ?? (SINGLE_LINKS.has(target.field) ? '' : LINKS[target.collection]?.[target.field] ? [] : '') : undefined; }
    if (target.kind === 'answer') return blueprint.questions.some(item => item.id === target.questionId && item.scope === 'section') ? blueprint.answers[target.questionId] || '' : undefined;
    if (target.kind === 'componentAnswer') {
      const component = blueprint.components.find(item => item.id === target.componentId);
      return component && blueprint.questions.some(item => item.id === target.questionId && item.scope === 'component') ? component.answers?.[target.questionId] || '' : undefined;
    }
    if (target.kind === 'topic') return AREAS[target.section]?.some(([area]) => area === target.area) ? blueprint.areas.find(item => item.section === target.section && item.area === target.area)?.title || '' : undefined;
    if (target.kind === 'add') return null;
    return undefined;
  }
  /**
   * Apply one approved suggestion to a blueprint in place, like a hand edit. `refs` maps batch references to the IDs of
   * records already created from them; links to records not created yet are returned in `pending`, to be resolved
   * with resolveResearchLinks once the batch is applied. A removed target, a field that changed since the research
   * (unless `force`), a duplicate name or a duplicate connection is a conflict: nothing changes.
   */
  function applyResearchSuggestion(blueprint, proposal, { value = proposal.value, force = false, newId, refs = new Map() } = {}) {
    const target = proposal.target, pending = [];
    const current = researchTargetValue(blueprint, target);
    if (current === undefined) return { conflict: 'The part this suggestion changes no longer exists.', missing: true };
    // Resolve one link value: @references through `refs`, IDs only while their record still exists.
    const resolve = (collection, field, given, recordId) => {
      const to = LINKS[collection][field], exists = id => blueprint[to].some(entry => entry.id === id);
      const one = id => { if (REF.test(id)) { const made = refs.get(id.slice(1)); if (made && exists(made)) return made; pending.push({ collection, id: recordId, field, ref: id.slice(1) }); return null; } return exists(id) ? id : null; };
      return SINGLE_LINKS.has(field) ? one(given) || '' : given.map(one).filter(Boolean);
    };
    if (target.kind === 'add') {
      const collection = target.collection, fields = value && typeof value === 'object' ? value : {};
      const id = newId(), entry = { id, origin: 'ai', ...RECORD_DEFAULTS[collection](collection === 'connections' ? undefined : String(fields[nameField(collection)] || '').trim()) };
      for (const [field, given] of Object.entries(fields)) {
        if (LINKS[collection]?.[field] !== undefined) entry[field] = resolve(collection, field, given, id);
        else if (SUGGEST_FIELDS[collection]?.[field] !== undefined && typeof given === 'string') entry[field] = suggestionValue(collection, field, given);
      }
      if (collection === 'connections') {
        if (!entry.from || !entry.to) return { conflict: 'Apply the two components of this connection first.' };
        if (!force && blueprint.connections.some(item => item.from === entry.from && item.to === entry.to)) return { conflict: 'These components are already connected.' };
      } else {
        const name = String(entry[nameField(collection)] || '').trim();
        if (!name) return { error: 'A new record needs a name.' };
        if (!force && blueprint[collection].some(item => String(item[nameField(collection)] || '').trim().toLowerCase() === name.toLowerCase())) return { conflict: `A ${RESEARCH_NOUN[collection]} named “${name}” already exists.` };
      }
      if (collection === 'sources') Object.assign(entry, { verification: 'unverified', accessedAt: today() }); // Research never verifies a source.
      if (KEYS[collection]) entry.key = nextKey(blueprint, collection);
      blueprint[collection].push(entry);
      if (proposal.ref) refs.set(proposal.ref, id);
      return { ok: true, created: { collection, id }, pending };
    }
    const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '') || (typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim());
    if (target.kind === 'record' && LINKS[target.collection]?.[target.field] !== undefined) {
      const entry = blueprint[target.collection].find(item => item.id === target.id);
      if (SINGLE_LINKS.has(target.field)) {
        if (!force && !same(current, proposal.original)) return { conflict: 'This link changed after the research ran.', current };
        entry[target.field] = resolve(target.collection, target.field, value, entry.id);
      } else entry[target.field] = [...new Set([...(entry[target.field] || []), ...resolve(target.collection, target.field, value, entry.id)])]; // Links are added, never removed.
      return { ok: true, pending };
    }
    if (!force && !same(current, proposal.original)) return { conflict: 'This field changed after the research ran.', current };
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (target.kind === 'idea') blueprint.idea = text;
    else if (target.kind === 'vision') blueprint.vision[target.field] = text;
    else if (target.kind === 'record') blueprint[target.collection].find(item => item.id === target.id)[target.field] = text;
    else if (target.kind === 'answer') blueprint.answers[target.questionId] = text;
    else if (target.kind === 'componentAnswer') { const component = blueprint.components.find(item => item.id === target.componentId); component.answers = { ...component.answers, [target.questionId]: text }; }
    else if (target.kind === 'topic') {
      const entry = blueprint.areas.find(item => item.section === target.section && item.area === target.area);
      if (entry) entry.title = text; else blueprint.areas.push({ id: newId(), origin: 'ai', ...RECORD_DEFAULTS.areas(text, target.section, target.area) });
    }
    return { ok: true, pending };
  }
  /** Links that pointed at records created later in the same batch. Returns the ones that still cannot be resolved. */
  function resolveResearchLinks(blueprint, pending, refs) {
    const left = [];
    for (const link of pending) {
      const entry = blueprint[link.collection]?.find(item => item.id === link.id), made = refs.get(link.ref), to = LINKS[link.collection]?.[link.field];
      if (!entry || !made || !blueprint[to]?.some(item => item.id === made)) { left.push(link); continue; }
      if (SINGLE_LINKS.has(link.field)) entry[link.field] = made; else entry[link.field] = [...new Set([...(entry[link.field] || []), made])];
    }
    return left;
  }
  /** A record's display name, for review cards and links. */
  const researchName = (blueprint, collection, id) => { const entry = blueprint[collection]?.find(item => item.id === id); return entry ? recordTitle(blueprint, collection, entry) : ''; };
  /** Where a suggestion goes, in the project's own words, for the review card. */
  function researchTargetLabel(blueprint, target) {
    const noun = RESEARCH_NOUN[target.collection] || target.collection;
    if (target.kind === 'idea') return 'Idea';
    if (target.kind === 'vision') return `${sectionTitle(blueprint, 'vision')} › ${questionText(blueprint, `vision:${target.field}`, VISION_QUESTIONS[target.field] || target.field)}`;
    if (target.kind === 'record') { const entry = blueprint[target.collection]?.find(item => item.id === target.id); return `${noun[0].toUpperCase()}${noun.slice(1)} “${clip(entry ? recordTitle(blueprint, target.collection, entry) : 'removed', 60)}” › ${target.field}`; }
    if (target.kind === 'answer') { const question = blueprint.questions.find(item => item.id === target.questionId); return question ? `${sectionTitle(blueprint, question.sectionId)} › ${clip(question.text, 80)}` : 'A removed question'; }
    if (target.kind === 'componentAnswer') { const component = blueprint.components.find(item => item.id === target.componentId), question = blueprint.questions.find(item => item.id === target.questionId); return `${component?.name || 'A removed component'} › ${clip(question?.text || 'a removed question', 60)}`; }
    if (target.kind === 'topic') return `${sectionTitle(blueprint, target.section)} › ${questionText(blueprint, `topic:${target.section}:${target.area}`, label(target.section, target.area))}`;
    if (target.kind === 'add') return `New ${noun}`;
    return 'Unknown target';
  }
  /**
   * Check one suggestion from a research agent against the blueprint. Returns { op, target, value, original, title, why,
   * evidence } or throws when the target does not exist, the field cannot be suggested or the value is invalid.
   */
  function validateResearchSuggestion(blueprint, raw, { refs = new Map() } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('A suggestion must be an object.');
    const source = raw.target && typeof raw.target === 'object' ? raw.target : {};
    let target, value, ref = '';
    if (source.kind === 'add') {
      if (!SUGGEST_ADD.includes(source.collection)) reject(`New records can be: ${SUGGEST_ADD.join(', ')}.`);
      if (!raw.value || typeof raw.value !== 'object' || Array.isArray(raw.value)) reject('A new record needs its fields.');
      target = { kind: 'add', collection: source.collection };
      value = {};
      for (const [field, given] of Object.entries(raw.value)) {
        if (LINKS[source.collection]?.[field] !== undefined) { if (given !== undefined && given !== null && !(Array.isArray(given) && !given.length) && given !== '') value[field] = linkValue(blueprint, source.collection, field, given, refs); }
        else if (SUGGEST_FIELDS[source.collection][field] !== undefined && typeof given === 'string' && given.trim()) value[field] = suggestionValue(source.collection, field, given);
      }
      if (source.collection === 'connections') { if (!value.from || !value.to || value.from === value.to) reject('A new connection needs two different components: from and to.'); }
      else if (!hasText(value[nameField(source.collection)])) reject(`A new ${RESEARCH_NOUN[source.collection] || source.collection} needs a ${nameField(source.collection)}.`);
      if (typeof raw.ref === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(raw.ref)) ref = raw.ref;
    } else {
      if (source.kind === 'idea') target = { kind: 'idea' };
      else if (source.kind === 'vision') target = { kind: 'vision', field: String(source.field) };
      else if (source.kind === 'record') target = { kind: 'record', collection: String(source.collection), id: String(source.id), field: String(source.field) };
      else if (source.kind === 'answer') target = { kind: 'answer', questionId: String(source.questionId) };
      else if (source.kind === 'componentAnswer') target = { kind: 'componentAnswer', componentId: String(source.componentId), questionId: String(source.questionId) };
      else if (source.kind === 'topic') target = { kind: 'topic', section: String(source.section), area: String(source.area) };
      else reject('Unknown suggestion target.');
      if (researchTargetValue(blueprint, target) === undefined) reject('The suggested target does not exist in this blueprint.');
      value = target.kind === 'record' && LINKS[target.collection]?.[target.field] !== undefined ? linkValue(blueprint, target.collection, target.field, raw.value, refs)
        : target.kind === 'record' ? suggestionValue(target.collection, target.field, raw.value)
        : typeof raw.value === 'string' && raw.value.trim() ? (raw.value.trim().length > (target.kind === 'topic' ? NAME : TEXT) ? raw.value.trim().slice(0, target.kind === 'topic' ? NAME : TEXT) : raw.value.trim()) : reject('A suggested value must be text.');
    }
    const original = researchTargetValue(blueprint, target);
    if (Array.isArray(value) && Array.isArray(original) && value.every(id => original.includes(id))) reject('The suggestion does not change anything.');
    if (target.kind !== 'add' && typeof original === 'string' && original.trim() === value) reject('The suggestion does not change anything.');
    const text = (input, max) => (typeof input === 'string' ? clip(input, max) : '');
    return { op: target.kind === 'add' ? 'add' : 'set', target, key: researchTargetKey(target), value, original, ...(ref ? { ref } : {}), title: text(raw.title, 160) || researchTargetLabel(blueprint, target), why: text(raw.why, 2000),
      evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).filter(item => typeof item === 'string' && item.trim()).slice(0, 10).map(item => clip(item, 500)) };
  }

  return { SCHEMA, VERSION, ID, PHASES, SECTIONS, ENUMS, AREAS, VISION, LIMITS, CONTEXT_COLLECTIONS, QUESTIONS, VISION_QUESTIONS, COMPONENT_FIELDS, SECTION_STATE, VERIFICATION_LABELS,
    label, sectionLabel, sectionTitle, phaseTitle, phaseList, questionText, lines, emptyBlueprint, nextKey, normalizeBlueprint, verification, isStarted, itemName, issues, readiness, sectionStates,
    composeSpec, orderItems, taskHome, taskContext, taskBody, suggestionBrief, researchTargets, researchContext, researchRecord, RESEARCH_FIELDS,
    SUGGEST_FIELDS, SUGGEST_ADD, LINKS, RECORD_DEFAULTS, researchTargetKey, researchTargetValue, researchTargetLabel, researchName, validateResearchSuggestion, applyResearchSuggestion, resolveResearchLinks };
})();
